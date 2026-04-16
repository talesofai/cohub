<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import {
	type ChannelConfig,
	type DiscordChannelConfig,
	type SpaceChannelRecord,
	type SpaceRecord,
	type SessionRecord,
	type SessionStreamEvent,
	createSpaceSession,
	deleteSpace,
	extractSessionRenderState,
	getModels,
	getSessionMessages,
	getSessionMessagesPaginated,
	postSessionMessage,
	streamSessionEvents,
	updateSpaceChannelConfig,
	createSpacePermission,
	createSessionPermission,
	deleteSpacePermission,
	deleteSessionPermission,
	type ResourcePermission,
	getSpaceFsTree,
	getSpaceFsFile,
	putSpaceFsFile,
	createSpaceFsDir,
	deleteSpaceFsNode,
	moveSpaceFsNode,
	type SpaceFsFileResponse,
	addSpaceCollaborator,
	listSpaceCollaborators,
	updateSpaceCollaborator,
	removeSpaceCollaborator,
} from "$lib/api";
import PageHeader from "$lib/components/PageHeader.svelte";
import ChatTimeline from "$lib/components/ChatTimeline.svelte";
import MobileRightDrawer from "$lib/components/MobileRightDrawer.svelte";
import ModelSelector from "$lib/components/ModelSelector.svelte";
import SessionComposer from "$lib/components/SessionComposer.svelte";
import SettingsOverlay from "$lib/components/SettingsOverlay.svelte";
import SpaceFileSidebar from "$lib/components/SpaceFileSidebar.svelte";
import type { SpaceFsNode } from "$lib/space-fs";
import { renderMarkdown } from "$lib/markdown";
import { type ChatMessage, type TimelineItem, toChatMessages } from "$lib/session-tree";
import { unreadTracker } from "$lib/stores/session-state.svelte";
import { messageCache } from "$lib/stores/message-cache";
import { authStore } from "$lib/stores/auth.svelte";
import { spaceStore } from "$lib/stores/space-store.svelte";
import { uiState, RIGHT_SIDEBAR_MAX, RIGHT_SIDEBAR_MIN } from "$lib/stores/ui.svelte";
import { hydrateSessionCacheToSpaceStore } from "$lib/stores/cache-hydration";
import {
	MOBILE_DRAWER_WIDTH_PX,
	getDrawerOpenRatio,
	resolveDrawerGestureDirection,
	getRightDrawerOffsetFromDrag,
	shouldOpenRightDrawer,
	shouldKeepRightDrawerOpen,
	shouldStartRightDrawerGesture,
	type DrawerGesturePhase,
	type DrawerGestureDirection,
} from "$lib/gestures/drawer-swipe";
import type { MessageRecord } from "@cohub/protocol";
import {
	ArrowDown,
	Brain,
	Check,
	Copy,
	Globe,
	Hash,
	Loader2,
	Lock,
	MoreVertical,
	PanelRightClose,
	PanelRightOpen,
	Pencil,
	Plus,
	Eye,
	Settings,
	Share2,
	Terminal,
	Trash2,
	User,
	X,
} from "lucide-svelte";
import type { ContentBlock } from "@cohub/protocol";
import { onMount, tick } from "svelte";

type Props = {
	data: {
		spaceId: string;
	};
};

type ComposerImageAttachment = {
	id: string;
	name: string;
	mediaType: string;
	data: string;
	previewUrl: string;
	size: number;
};

const MAX_IMAGE_EDGE = 2160;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const WEBP_QUALITIES = [0.88, 0.82, 0.76, 0.7, 0.62, 0.54];

type SessionViewState = {
	session: SessionRecord;
	messages: MessageRecord[];
	loading: boolean;
	loaded: boolean;
	error: string;
	// Pagination state
	hasMore: boolean;
	loadingOlder: boolean;
	oldestCursor: number | undefined;
};

const props = $props();
const data = $derived((props as Props).data);
const spaceId = $derived(data.spaceId);

// Session from URL query param
const urlSessionId = $derived(page.url.searchParams.get("session"));
const urlFilePath = $derived(page.url.searchParams.get("file"));

let space = $state<SpaceRecord | null>(null);
let spaceSessions = $state<SessionRecord[]>([]);
let spaceChannels = $state<SpaceChannelRecord[]>([]);
let sessionStateById = $state<Record<string, SessionViewState>>({});
let activeSessionId = $state<string | null>(null);
let input = $state("");
let imageAttachments = $state<ComposerImageAttachment[]>([]);
let sending = $state(false);
let spaceLoadError = $state("");
let streamStatus = $state<"idle" | "streaming" | "done" | "error">("idle");
let streamError = $state("");
let streamingAssistantText = $state("");
let streamingThinking = $state("");

// Raw content blocks from the latest SSE event, used to preserve
// the correct interleaving order of text/thinking/tool_use blocks.
let streamingContentBlocks = $state<ContentBlock[]>([]);

// ─── Model selection ───

type SelectedModel = {
	provider: string;
	id: string;
	name?: string;
};

let modelsCatalog = $state<Array<{ provider: string; id: string; model: Record<string, unknown> }> | null>(null);
let showModelSelector = $state(false);

// Per-session model selection stored in localStorage
function getSessionModelKey(sessionId: string): string {
	return `cohub:model:${sessionId}`;
}

function loadSessionModel(sessionId: string): SelectedModel | null {
	try {
		const raw = localStorage.getItem(getSessionModelKey(sessionId));
		return raw ? (JSON.parse(raw) as SelectedModel) : null;
	} catch {
		return null;
	}
}

function saveSessionModel(sessionId: string, model: SelectedModel | null) {
	if (!model) {
		localStorage.removeItem(getSessionModelKey(sessionId));
	} else {
		localStorage.setItem(getSessionModelKey(sessionId), JSON.stringify(model));
	}
}

// Current model for the active session
let sessionModelById = $state<Record<string, SelectedModel | null>>({});

// The first model from the catalog (used as fallback when no explicit selection)
const firstCatalogModel = $derived(
	modelsCatalog && modelsCatalog.length > 0
		? {
			provider: modelsCatalog[0].provider,
			id: modelsCatalog[0].id,
			name: modelsCatalog[0].model.name as string | undefined,
		}
		: null,
);

const activeSessionModel = $derived.by(() => {
	if (!activeSessionId) return null;
	const explicit = sessionModelById[activeSessionId];
	// Explicit selection wins; otherwise fall back to the first catalog model
	return explicit ?? firstCatalogModel;
});

async function loadModelsCatalog() {
	if (modelsCatalog) return;
	try {
		const catalog = await getModels();
		// API returns { provider: ModelCatalogEntry[] } — flatten to array
		const items: Array<{ provider: string; id: string; model: Record<string, unknown> }> = [];
		for (const [, entries] of Object.entries(catalog)) {
			for (const entry of entries) {
				items.push(entry);
			}
		}
		modelsCatalog = items;
	} catch (err) {
		console.error("Failed to load models catalog:", err);
	}
}

function handleModelSelect(model: { provider: string; id: string }) {
	if (!activeSessionId) return;
	// Look up the display name from the catalog
	const catalogItem = modelsCatalog?.find(
		(m) => m.provider === model.provider && m.id === model.id,
	);
	const selected: SelectedModel = {
		provider: model.provider,
		id: model.id,
		name: catalogItem?.model.name as string | undefined,
	};
	sessionModelById = {
		...sessionModelById,
		[activeSessionId]: selected,
	};
	saveSessionModel(activeSessionId, selected);
	showModelSelector = false;
}

// SSE - per-session connections
let sessionSSEs = new Map<string, AbortController>();
let sessionLastEventIds = new Map<string, string>();
let sessionReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
let sessionReconnectAttempts = new Map<string, number>();
let pageMounted = false;
let pageVisible = true;
let pageOnline = true;

// Sequential event processing queue to prevent race conditions
let eventProcessing = false;
let eventQueue: SessionStreamEvent[] = [];

// Track which session is currently streaming (for sidebar status)
let streamingSessionId: string | null = null;

// Broadcast channel for cross-tab / cross-component session updates
let broadcastChannel: BroadcastChannel | null = null;

function notifySessionsUpdate() {
	// Use sorted sessions from store, not the local unsorted spaceSessions
	const sessions = spaceStore.getSessions(spaceId) ?? spaceSessions;
	// Notify sidebar about session changes
	window.dispatchEvent(
		new CustomEvent("cohub:sessions-updated", {
			detail: { spaceId, sessions },
		}),
	);
	broadcastChannel?.postMessage({
		type: "sessions-updated",
		spaceId,
		sessions: JSON.parse(JSON.stringify(sessions)),
	});
}

function notifyPermissionsUpdate() {
	window.dispatchEvent(
		new CustomEvent("cohub:permissions-updated", {
			detail: { spaceId },
		}),
	);
}

function notifyStreamingStatus(sessionId: string | null, isStreaming: boolean) {
	window.dispatchEvent(
		new CustomEvent("cohub:streaming-status", {
			detail: { spaceId, sessionId, isStreaming },
		}),
	);
	broadcastChannel?.postMessage({
		type: "streaming-status",
		spaceId,
		sessionId,
		isStreaming,
	});
}

let spacePollingTimer: ReturnType<typeof setTimeout> | null = null;
let loadingPermissions = $state(false);
let loadingChannels = $state(false);
const listEl = $state<HTMLDivElement | null>(null);
let savingChannelConfigById = $state<Record<string, boolean>>({});
let channelConfigErrorById = $state<Record<string, string>>({});
let loadingSessionIds = $state<Record<string, boolean>>({});
let bootstrapping = $state(true);
// In column-reverse: scrollTop=0 is the visual top, scrollTop=max is the
// visual bottom. We track if the user has manually scrolled up (away from bottom).
let hasScrolledUp = $state(false);

let creatingSession = $state(false);
let createSessionError = $state("");
let showSettings = $state(false);
let showMoreMenu = $state(false);
let showScrollToBottom = $state(false);
let rightSidebarResizeCleanup: (() => void) | null = null;

// Share / Permissions
let spacePermissions = $state<ResourcePermission[]>([]);
let spacePermissionsLoaded = $state(false);
const sessionTitleById = $derived.by(() => {
	const map = new Map<string, string>();
	for (const session of spaceSessions) {
		const label = session.title || session.latestMessageText || `Session ${session.id.slice(0, 8)}`;
		map.set(session.id, label);
	}
	return map;
});
const sharedSessionPermissions = $derived(
	spacePermissions.filter((permission) => permission.resourceType === "session"),
);
let spacePublicRead = $state(false);
let savingSpacePerm = $state(false);
let shareCopied = $state(false);
let shareCopiedTimer: ReturnType<typeof setTimeout> | null = null;
let showShareModal = $state(false);
let shareModalSessionId = $state<string | null>(null);

let shareModalError = $state("");
let shareModalSaving = $state(false);
let sessionPermError = $state("");
let isOwner = $state(false);

// Collaborators
let spaceCollaborators = $state<ResourcePermission[]>([]);
let collaboratorsLoaded = $state(false);
let loadingCollaborators = $state(false);
let addingCollaboratorUuid = $state("");
let addingCollaboratorLevel = $state<"read" | "write">("write");
let addingCollaboratorError = $state("");
let savingCollaborator = $state(false);

// Write permission: owner always has write access;
// non-owners need to be a collaborator with "write" level.
let canWrite = $derived(
  isOwner ||
  spaceCollaborators.some(
    (c) => c.granteeUuid === authStore.userUuid && c.level === "write",
  ),
);


// Chat timeline ref (for API compat with preparePrepend/finalizePrepend no-ops)
type ChatTimelineHandle = {
	preparePrepend: () => void;
	finalizePrepend: () => void;
};
let chatTimelineRef = $state<ChatTimelineHandle | null>(null);

// Preload tracking: debounce to avoid multiple concurrent loads
let preloadingSessionIds = new Set<string>();
const PRELOAD_THRESHOLD = 10;

// Space actions
let spaceActionError = $state("");
let spaceActionInProgress: string | null = $state(null);

// No-write-permission hint toast
let showNoWriteHint = $state(false);
let noWriteHintTimer: ReturnType<typeof setTimeout> | null = null;

function triggerNoWriteHint() {
	if (noWriteHintTimer) clearTimeout(noWriteHintTimer);
	showNoWriteHint = true;
	noWriteHintTimer = setTimeout(() => { showNoWriteHint = false; }, 3000);
}

let fileTree = $state<SpaceFsNode[]>([]);
let fileTreeLoading = $state(false);
let fileTreeError = $state<string | null>(null);
const fileMode = $derived<("chat" | "file")>(urlFilePath ? "file" : "chat");
let openFile = $state<SpaceFsFileResponse | null>(null);
let openFileDraft = $state("");
let openFileLoading = $state(false);
let openFileSaving = $state(false);
let openFileError = $state<string | null>(null);
let fileEdit = $state(true);
let fileMarkdownHtml = $state("");
let openFileTooLarge = $state(false);

async function handleDelete() {
	if (!confirm("Delete this space permanently? This cannot be undone."))
		return;
	spaceActionInProgress = "delete";
	spaceActionError = "";
	try {
		await deleteSpace(spaceId);
		spaceStore.removeSpace(spaceId);
		await goto("/spaces");
	} catch (error) {
		spaceActionError =
			error instanceof Error ? error.message : "Failed to delete";
	} finally {
		spaceActionInProgress = null;
	}
}

const activeSessionState = $derived(
	activeSessionId ? (sessionStateById[activeSessionId] ?? null) : null,
);

function isIntermediate(msg: ChatMessage): boolean {
	if (msg.meta?.messageKind === "assistant_intermediate") return true;
	return msg.content?.some((b) => b.type === "tool_use") ?? false;
}

function groupIntermediateMessages(items: TimelineItem[]): TimelineItem[] {
	const result: TimelineItem[] = [];
	let buffer: ChatMessage[] = [];

	function flushBuffer() {
		if (buffer.length === 0) return;
		const id = `process-${buffer.map((m) => m.id).join("|")}`;
		result.push({ id, kind: "process", messages: [...buffer] });
		buffer = [];
	}

	for (const item of items) {
		if (item.kind !== "message") {
			flushBuffer();
			result.push(item);
			continue;
		}

		const msg = item.message;
		if (msg.role !== "assistant" || !isIntermediate(msg)) {
			// user/system message or assistant without tool_use → final
			flushBuffer();
			result.push(item);
		} else {
			// Intermediate assistant message → collect
			buffer.push(msg);
		}
	}

	flushBuffer();
	return result;
}

const timeline = $derived.by<TimelineItem[]>(() => {
	const state = activeSessionState;
	if (!state) return [];
	const items: TimelineItem[] = toChatMessages(state.messages).map(
		(message) => ({
			id: message.id,
			kind: "message",
			message,
		}),
	);

	// Group historical messages (before the current turn) into process cards.
	// Only the messages after the last user turn are kept flat during streaming
	// so tool cards and streaming text render inline as they arrive.
	const lastUserIndex = (() => {
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (item.kind === "message" && item.message.role === "user") {
				return i;
			}
		}
		return -1;
	})();

	// Group the historical portion
	if (lastUserIndex >= 0) {
		const historyItems = items.slice(0, lastUserIndex + 1);
		const groupedHistory = groupIntermediateMessages(historyItems);
		const streamingItems = items.slice(lastUserIndex + 1);

		if (streamStatus === "streaming" || streamingContentBlocks.length > 0) {
			// Append items that arrived after the last user message first
			for (const item of streamingItems) {
				groupedHistory.push(item);
			}

			// Then append the live streaming content at the very end
			if (streamingContentBlocks.length > 0) {
				let accText = "";
				let accThinking = "";
				const baseSequence = state.messages.at(-1)?.sequence ?? 0;

				function flushMessage() {
					const trimmedText = accText.trim();
					const trimmedThinking = accThinking.trim();
					if (!trimmedText && !trimmedThinking) return;

					const blocks: ContentBlock[] = [];
					if (trimmedThinking) blocks.push({ type: "thinking", thinking: trimmedThinking });
					if (trimmedText) blocks.push({ type: "text", text: trimmedText });

					groupedHistory.push({
						id: `assistant-streaming-seg-${groupedHistory.length}`,
						kind: "message",
						message: {
							id: "assistant-streaming",
							role: "assistant",
							content: blocks as never,
							text: trimmedText,
							sequence: baseSequence + 1,
						},
					});
					accText = "";
					accThinking = "";
				}

				for (const block of streamingContentBlocks) {
					if (block.type === "thinking") {
						accThinking += (accThinking ? "\n" : "") + block.thinking;
					} else if (block.type === "text") {
						accText += (accText ? "\n\n" : "") + block.text;
					} else if (block.type === "tool_use") {
						// Flush accumulated text/thinking before inserting tool card
						flushMessage();
						const meta = block._meta as
							| { toolStatus?: string; summary?: string }
							| undefined;
						groupedHistory.push({
							id: `stream-tool-${block.id}`,
							kind: "tool",
							tool: {
								id: block.id,
								name: block.name,
								input: block.input ?? {},
								status:
									meta?.toolStatus === "running"
										? "running"
										: meta?.toolStatus === "done"
											? "done"
											: "failed",
								output: meta?.summary ?? "",
							},
						});
					}
				}

				// Flush remaining text/thinking after the last tool
				flushMessage();
			} else if (streamingAssistantText.trim() || streamingThinking.trim()) {
				// Fallback: when raw blocks aren't available yet, use the flat state
				const contentBlocks: Array<
					{ type: "thinking"; thinking: string } | { type: "text"; text: string }
				> = [];
				if (streamingThinking.trim()) {
					contentBlocks.push({ type: "thinking", thinking: streamingThinking });
				}
				if (streamingAssistantText.trim()) {
					contentBlocks.push({ type: "text", text: streamingAssistantText });
				}
				groupedHistory.push({
					id: "assistant-streaming",
					kind: "message",
					message: {
						id: "assistant-streaming",
						role: "assistant",
						content: contentBlocks as never,
						text: streamingAssistantText,
						sequence: (state.messages.at(-1)?.sequence ?? 0) + 1,
					},
				});
			}

			// Group all items (including streaming) so process cards stay collapsed
			// by default and the summary numbers update as messages arrive
			return groupIntermediateMessages(groupedHistory);
		}

		// Not streaming: group the streaming portion too
		return groupIntermediateMessages([...groupedHistory, ...streamingItems]);
	}

	// No user messages at all: group everything
	return groupIntermediateMessages(items);
});

$effect(() => {
	const currentSpace = space;
	const userUuid = authStore.userUuid;
	if (currentSpace) {
		isOwner = currentSpace.userUuid === userUuid;
	}
});

// Collapse right sidebar when user doesn't have write permission
$effect(() => {
	if (!canWrite && typeof window !== "undefined") {
		uiState.setRightSidebarCollapsed(true);
	}
});

// Inject shared space into sidebar when non-owner views it
$effect(() => {
	const currentSpace = space;
	if (currentSpace && !isOwner) {
		// Check if already in the space list
		const alreadyInList = spaceStore.spaceList.some((r) => r.id === currentSpace.id);
		if (!alreadyInList) {
			// Inject at the front of the list so it appears first in sidebar
			spaceStore.injectSharedSpace(currentSpace);
		}
	}
});

// Sync active session with URL
$effect(() => {
	if (urlSessionId && urlSessionId !== activeSessionId) {
		activeSessionId = urlSessionId;
		ensureSessionModelLoaded(urlSessionId);
		// Reset scroll state on session switch
		hasScrolledUp = false;
		// Mark session as viewed when navigating to it
		const state = sessionStateById[urlSessionId];
		if (state?.session?.lastMessageId) {
			unreadTracker.markViewed(urlSessionId, state.session.lastMessageId);
		}
	}
});

// Load saved model for a session (called explicitly, not via $effect)
function ensureSessionModelLoaded(sessionId: string) {
	if (sessionModelById[sessionId]) return;
	const saved = loadSessionModel(sessionId);
	sessionModelById = {
		...sessionModelById,
		[sessionId]: saved,
	};
}

function updateUrlSession(sessionId: string | null) {
	const params = new URLSearchParams(page.url.searchParams);
	if (sessionId) {
		params.set("session", sessionId);
	} else {
		params.delete("session");
	}
	void goto(`/spaces/${spaceId}?${params.toString()}`, {
		replaceState: true,
	});
}

function mergeMessagesById(
	existing: MessageRecord[],
	incoming: MessageRecord[],
	options?: { preferIncoming?: boolean },
): MessageRecord[] {
	const preferIncoming = options?.preferIncoming ?? true;
	const byId = new Map(existing.map((message) => [message.id, message]));
	for (const message of incoming) {
		const current = byId.get(message.id);
		if (!current) {
			byId.set(message.id, message);
			continue;
		}
		byId.set(
			message.id,
			preferIncoming
				? {
					...current,
					...message,
				}
				: {
					...message,
					...current,
				},
		);
	}
	return Array.from(byId.values()).sort((a, b) => a.sequence - b.sequence);
}

function makeFsNode(entry: {
	name: string;
	path: string;
	type: "file" | "dir" | "symlink";
	size: number;
	mimeType: string | null;
	mtimeMs: number;
}): SpaceFsNode {
	return {
		...entry,
		children: [],
		isOpen: false,
		isLoaded: false,
		isLoading: false,
	};
}

function replaceNodeChildren(nodes: SpaceFsNode[], nodePath: string, children: SpaceFsNode[]): SpaceFsNode[] {
	return nodes.map((node) => {
		if (node.path === nodePath) {
			return { ...node, children, isLoaded: true, isLoading: false, isOpen: true };
		}
		if (node.children.length > 0) {
			return { ...node, children: replaceNodeChildren(node.children, nodePath, children) };
		}
		return node;
	});
}

function updateNodeState(nodes: SpaceFsNode[], nodePath: string, updater: (node: SpaceFsNode) => SpaceFsNode): SpaceFsNode[] {
	return nodes.map((node) => {
		if (node.path === nodePath) return updater(node);
		if (node.children.length > 0) {
			return { ...node, children: updateNodeState(node.children, nodePath, updater) };
		}
		return node;
	});
}

async function loadFileTree(force = false) {
	if (fileTreeLoading && !force) return;
	fileTreeLoading = true;
	fileTreeError = null;
	try {
		const tree = await getSpaceFsTree(spaceId, "");
		fileTree = tree.entries.map(makeFsNode);
	} catch (error) {
		fileTreeError = error instanceof Error ? error.message : "Failed to load files";
	} finally {
		fileTreeLoading = false;
	}
}

async function expandDirectory(node: SpaceFsNode) {
	if (node.type !== "dir") return;
	if (node.isOpen) {
		fileTree = updateNodeState(fileTree, node.path, (item) => ({ ...item, isOpen: false }));
		return;
	}
	if (node.isLoaded) {
		fileTree = updateNodeState(fileTree, node.path, (item) => ({ ...item, isOpen: true }));
		return;
	}
	fileTree = updateNodeState(fileTree, node.path, (item) => ({ ...item, isLoading: true, isOpen: true }));
	try {
		const tree = await getSpaceFsTree(spaceId, node.path);
		fileTree = replaceNodeChildren(fileTree, node.path, tree.entries.map(makeFsNode));
	} catch (error) {
		fileTree = updateNodeState(fileTree, node.path, (item) => ({ ...item, isLoading: false }));
		fileTreeError = error instanceof Error ? error.message : "Failed to load directory";
	}
}

async function openSpaceFile(path: string) {
	const params = new URLSearchParams(page.url.searchParams);
	params.set("file", path);
	void goto(`/spaces/${spaceId}?${params.toString()}`, { replaceState: true });
}

async function saveOpenFile() {
	if (!openFile || openFile.kind !== "text") return;
	openFileSaving = true;
	openFileError = null;
	try {
		await putSpaceFsFile(spaceId, {
			path: openFile.path,
			content: openFileDraft,
			encoding: "utf-8",
		});
		openFile = { ...openFile, content: openFileDraft, size: new Blob([openFileDraft]).size };
		await loadFileTree(true);
	} catch (error) {
		openFileError = error instanceof Error ? error.message : "Failed to save file";
	} finally {
		openFileSaving = false;
	}
}

async function handleCreateFile(parentPath: string) {
	const name = prompt("New file name");
	if (!name?.trim()) return;
	const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
	try {
		await putSpaceFsFile(spaceId, { path, content: "", encoding: "utf-8" });
		await loadFileTree(true);
		await openSpaceFile(path);
	} catch (error) {
		fileTreeError = error instanceof Error ? error.message : "Failed to create file";
	}
}

async function handleCreateDir(parentPath: string) {
	const name = prompt("New folder name");
	if (!name?.trim()) return;
	const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
	try {
		await createSpaceFsDir(spaceId, path);
		await loadFileTree(true);
	} catch (error) {
		fileTreeError = error instanceof Error ? error.message : "Failed to create folder";
	}
}

async function handleRenameNode(node: SpaceFsNode) {
	const nextName = prompt("Rename", node.name);
	if (!nextName?.trim() || nextName.trim() === node.name) return;
	const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
	const toPath = parent ? `${parent}/${nextName.trim()}` : nextName.trim();
	try {
		await moveSpaceFsNode(spaceId, { fromPath: node.path, toPath });
		await loadFileTree(true);
		if (urlFilePath === node.path) {
			await openSpaceFile(toPath);
		}
	} catch (error) {
		fileTreeError = error instanceof Error ? error.message : "Failed to rename";
	}
}

async function handleDeleteNode(node: SpaceFsNode) {
	if (!confirm(`Delete ${node.name}?`)) return;
	try {
		await deleteSpaceFsNode(spaceId, node.path, node.type === "dir");
		if (urlFilePath === node.path) {
			const params = new URLSearchParams(page.url.searchParams);
			params.delete("file");
			void goto(`/spaces/${spaceId}?${params.toString()}`, { replaceState: true });
		}
		await loadFileTree(true);
	} catch (error) {
		fileTreeError = error instanceof Error ? error.message : "Failed to delete";
	}
}

const fileDirty = $derived(Boolean(openFile && openFile.kind === "text" && openFileDraft !== openFile.content));

const openFileIsMarkdown = $derived(Boolean(openFile?.kind === "text" && /\.md$/i.test(openFile.path)));
const openFileExt = $derived.by(() => {
	if (!openFile || openFile.kind !== "text") return "plaintext";
	return openFile.name.split(".").pop()?.toLowerCase() ?? "plaintext";
});
const openFileIsImage = $derived(Boolean(openFile?.mimeType?.startsWith("image/")));
const openFileIsVideo = $derived(Boolean(openFile?.mimeType?.startsWith("video/")));
const openFileIsText = $derived(Boolean(openFile?.kind === "text"));
const openFileDownloadUrl = $derived.by(() => {
	if (!urlFilePath) return "";
	return `/api/spaces/${spaceId}/fs/download?path=${encodeURIComponent(urlFilePath)}`;
});
const openFileDownloadName = $derived.by(() => {
	if (!urlFilePath) return "";
	return urlFilePath.split("/").pop() ?? "download";
});

// Render markdown preview when file is markdown
$effect(() => {
	const current = openFile;
	if (!current || current.kind !== "text" || !/\.md$/i.test(current.path)) {
		fileMarkdownHtml = "";
		return;
	}
	void renderMarkdown(current.content).then((html) => {
		if (openFile?.path === current.path) fileMarkdownHtml = html;
	}).catch(() => {
		fileMarkdownHtml = "";
	});
});

async function handleFileSelect(node: SpaceFsNode) {
	if (node.type !== "file") {
		await expandDirectory(node);
		return;
	}
	await openSpaceFile(node.path);
	uiState.mobileRightDrawerOpen = false;
}

async function handleFileToggle(node: SpaceFsNode) {
	await expandDirectory(node);
}

async function refreshFileTree() {
	await loadFileTree(true);
}

// URL-driven file viewer: load file when ?file= is set, close when cleared
$effect(() => {
	const path = urlFilePath;
	if (path) {
		void (async () => {
			openFileLoading = true;
			openFileError = null;
			openFileTooLarge = false;
			try {
				const file = await getSpaceFsFile(spaceId, path);
				if (urlFilePath !== path) return;
				openFile = file;
				openFileDraft = file.kind === "text" ? file.content : "";
				fileEdit = true;
			} catch (error) {
				if (urlFilePath !== path) return;
				const msg = error instanceof Error ? error.message : "";
				// Detect file_too_large error (API returns 413 with code "file_too_large")
				if (msg.includes("file_too_large")) {
					openFileTooLarge = true;
					openFileError = null;
				} else {
					openFile = null;
					openFileDraft = "";
					openFileError = error instanceof Error ? error.message : "Failed to open file";
					openFileTooLarge = false;
				}
			} finally {
				if (urlFilePath === path) {
					openFileLoading = false;
				}
			}
		})();
	} else {
		openFile = null;
		openFileDraft = "";
		openFileError = null;
		openFileTooLarge = false;
		fileMarkdownHtml = "";
	}
});

function closeFile() {
	const params = new URLSearchParams(page.url.searchParams);
	params.delete("file");
	void goto(`/spaces/${spaceId}?${params.toString()}`, { replaceState: true });
}

function handleFileInput(value: string) {
	openFileDraft = value;
}

async function handleFileKeyboardSave(event: KeyboardEvent) {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && fileMode === "file") {
		event.preventDefault();
		await saveOpenFile();
	}
}

async function handleCreateNewSession() {
	if (creatingSession || !space) return;
	creatingSession = true;
	createSessionError = "";

	try {
		const result = await createSpaceSession(space.id, { source: "web" });
		const newSession = result.session;

		spaceSessions = [...spaceSessions, newSession];
		spaceStore.patchSession(space.id, newSession);
		sessionStateById = {
			...sessionStateById,
			[newSession.id]: {
				session: newSession,
				messages: [],
				loading: false,
				loaded: true,
				error: "",
				hasMore: false,
				loadingOlder: false,
				oldestCursor: undefined,
			},
		};

		activeSessionId = newSession.id;
		ensureSessionModelLoaded(newSession.id);
		updateUrlSession(newSession.id);
		notifySessionsUpdate();
	} catch (error) {
		createSessionError =
			error instanceof Error ? error.message : "Failed to create session";
	} finally {
		creatingSession = false;
	}
}

function seedSessions(sessions: SessionRecord[]) {
	if (sessions.length === 0 && spaceSessions.length > 0) return;

	spaceSessions = sessions;
	const nextState = { ...sessionStateById };
	for (const session of sessions) {
		if (!nextState[session.id]) {
			nextState[session.id] = {
				session,
				messages: [],
				loading: false,
				loaded: false,
				error: "",
				hasMore: true,
				loadingOlder: false,
				oldestCursor: undefined,
			};
		} else {
			nextState[session.id] = {
				...nextState[session.id],
				session,
			};
		}
	}
	sessionStateById = nextState;

	// Notify sidebar about session changes
	spaceStore.setSessions(spaceId, sessions);
	notifySessionsUpdate();

	// Auto-select session from URL or fallback to latest
	if (urlSessionId && !sessionStateById[urlSessionId]?.loaded) {
		ensureSessionModelLoaded(urlSessionId);
		// Will be loaded by the effect below
	} else if (!activeSessionId && sessions.length > 0) {
		const nextId = sessions.at(-1)?.id ?? null;
		if (nextId) {
			activeSessionId = nextId;
			ensureSessionModelLoaded(nextId);
			updateUrlSession(nextId);
		}
	}
}

function getDiscordSpaceChannelConfig(
	spaceChannel: SpaceChannelRecord,
): DiscordChannelConfig {
	return (
		(spaceChannel.config as DiscordChannelConfig) ?? {
			inbound: { requireMentionInGuild: true },
			outbound: { showThinking: false, showToolCalls: false },
		}
	);
}

async function saveSpaceChannelConfig(
	spaceChannelId: string,
	config: ChannelConfig,
) {
	savingChannelConfigById = {
		...savingChannelConfigById,
		[spaceChannelId]: true,
	};
	channelConfigErrorById = {
		...channelConfigErrorById,
		[spaceChannelId]: "",
	};

	try {
		const updated = await updateSpaceChannelConfig(spaceChannelId, {
			config,
		});
		spaceChannels = spaceChannels.map((item) =>
			item.id === spaceChannelId ? updated : item,
		);
	} catch (error) {
		channelConfigErrorById = {
			...channelConfigErrorById,
			[spaceChannelId]:
				error instanceof Error
					? error.message
					: "Failed to update channel config",
		};
	} finally {
		savingChannelConfigById = {
			...savingChannelConfigById,
			[spaceChannelId]: false,
		};
	}
}

function patchDiscordSpaceChannelConfig(
	spaceChannel: SpaceChannelRecord,
	updater: (config: DiscordChannelConfig) => DiscordChannelConfig,
) {
	const nextConfig = updater(getDiscordSpaceChannelConfig(spaceChannel));
	spaceChannels = spaceChannels.map((item) =>
		item.id === spaceChannel.id ? { ...item, config: nextConfig } : item,
	);
	void saveSpaceChannelConfig(spaceChannel.id, nextConfig);
}

async function loadSpace(options?: { force?: boolean; includeChannels?: boolean }) {
	spaceLoadError = "";
	const force = options?.force ?? false;
	const includeChannels = options?.includeChannels ?? false;

	const cachedSpace = spaceStore.getSpace(spaceId);
	if (cachedSpace && !space) {
		space = cachedSpace as SpaceRecord;
		isOwner = cachedSpace.userUuid === authStore.userUuid;
	}

	const cachedSessions = spaceStore.getSessions(spaceId);
	if (!cachedSessions) {
		hydrateSessionCacheToSpaceStore(spaceId);
	}
	const fallbackSessions = cachedSessions ?? spaceStore.getSessions(spaceId);
	if (fallbackSessions && spaceSessions.length === 0) {
		seedSessions(fallbackSessions);
	}

	const tasks: Array<Promise<void>> = [];

	tasks.push((async () => {
		try {
			const spaceResult = await spaceStore.ensureSpaceDetail(spaceId, { force: force || shouldPollSpace(spaceStore.getSpace(spaceId) as SpaceRecord | null) });
			space = spaceResult;
			isOwner = spaceResult.userUuid === authStore.userUuid;
		} catch (error) {
			spaceLoadError =
				error instanceof Error
					? error.message
					: "Failed to load space";
		}
	})());

	tasks.push((async () => {
		try {
			const sessions = await spaceStore.ensureSpaceSessions(spaceId, { force });
			seedSessions(sessions);
		} catch (error) {
			if (!spaceLoadError) {
				spaceLoadError =
					error instanceof Error
						? error.message
						: "Failed to load space sessions";
			}
		}
	})());

	if (includeChannels) {
		tasks.push((async () => {
			try {
				const channels = await spaceStore.ensureSpaceChannels(spaceId, { force });
				spaceChannels = channels;
			} catch (error) {
				if (!spaceLoadError) {
					spaceLoadError =
						error instanceof Error
							? error.message
							: "Failed to load space channels";
				}
			}
		})());
	} else {
		const cachedChannels = spaceStore.getSpaceChannels(spaceId);
		if (cachedChannels && spaceChannels.length === 0) {
			spaceChannels = cachedChannels;
		}
	}

	await Promise.all(tasks);
}

async function loadSessionState(sessionId: string, force = false) {
	const existing = sessionStateById[sessionId];
	if (loadingSessionIds[sessionId] && !force) return;
	if (existing?.loaded && !force) return;

	// Try cache first: stale-while-revalidate
	const cached = await messageCache.get(sessionId);
	if (cached && cached.messages.length > 0 && !force) {
		sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				session: existing?.session,
				messages: cached.messages,
				loading: false,
				loaded: true,
				error: "",
				hasMore: cached.hasMore,
				loadingOlder: false,
				oldestCursor: cached.oldestSeq != null ? cached.oldestSeq : undefined,
			},
		};

		// Background sync: fetch newer messages since cache
		void syncSessionNewer(sessionId, cached);

		return;
	}

	// No cache or force: load latest page from server
	loadingSessionIds = { ...loadingSessionIds, [sessionId]: true };
	sessionStateById = {
		...sessionStateById,
		[sessionId]: {
			session: existing?.session,
			messages: existing?.messages ?? [],
			loading: true,
			loaded: existing?.loaded ?? false,
			error: existing?.error ?? "",
			hasMore: existing?.hasMore ?? true,
			loadingOlder: false,
			oldestCursor: existing?.oldestCursor,
		},
	};

	try {
		const response = await getSessionMessagesPaginated(sessionId, {
			limit: 30,
		});

		await messageCache.set({
			sessionId,
			messages: response.messages,
			hasMore: response.hasMore,
			oldestSeq: response.messages[0]?.sequence ?? null,
			newestSeq: response.messages.at(-1)?.sequence ?? null,
			cachedAt: Date.now(),
		});
		void messageCache.evict();

		sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				session: response.session,
				messages: response.messages,
				loading: false,
				loaded: true,
				error: "",
				hasMore: response.hasMore,
				loadingOlder: false,
				oldestCursor: response.hasMore && response.messages.length > 0
					? response.messages[0].sequence
					: undefined,
			},
		};
	} catch (error) {
		sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				session: existing?.session,
				messages: existing?.messages ?? [],
				loading: false,
				loaded: true,
				error:
					error instanceof Error ? error.message : "Failed to load session",
				hasMore: existing?.hasMore ?? true,
				loadingOlder: false,
				oldestCursor: existing?.oldestCursor,
			},
		};
	} finally {
		loadingSessionIds = { ...loadingSessionIds, [sessionId]: false };
	}
}

/** Sync newer messages since last cache (for background refresh) */
async function syncSessionNewer(
	sessionId: string,
	cached: Awaited<ReturnType<typeof messageCache.get>>,
) {
	if (!cached || cached.messages.length === 0) return;
	const lastSeq = cached.newestSeq;
	if (lastSeq == null) return;

	try {
		const response = await getSessionMessagesPaginated(sessionId, {
			cursor: lastSeq,
			direction: "newer",
			limit: 100,
		});
		if (response.messages.length > 0) {
			await messageCache.append(sessionId, response.messages);
			const state = sessionStateById[sessionId];
			if (state) {
				const merged = mergeMessagesById(state.messages, response.messages, {
					preferIncoming: true,
				});
				if (merged.length !== state.messages.length) {
					sessionStateById = {
						...sessionStateById,
						[sessionId]: {
							...state,
							messages: merged,
						},
					};
				} else if (response.messages.some((m) => state.messages.some((s) => s.id === m.id))) {
					sessionStateById = {
						...sessionStateById,
						[sessionId]: {
							...state,
							messages: merged,
						},
					};
				}
			}
		}
	} catch {
		// Ignore sync errors
	}
}

/** Load older messages (scroll up pagination) */
async function loadOlderMessages(sessionId: string) {
	const state = sessionStateById[sessionId];
	if (!state || !state.hasMore || state.loadingOlder) return;

	// Prepare scroll position restoration
	chatTimelineRef?.preparePrepend();

	sessionStateById = {
		...sessionStateById,
		[sessionId]: {
			...state,
			loadingOlder: true,
		},
	};

	try {
		const response = await getSessionMessagesPaginated(sessionId, {
			cursor: state.oldestCursor,
			direction: "older",
			limit: 30,
		});

		if (response.messages.length > 0) {
			await messageCache.prepend(sessionId, response.messages, response.hasMore);

			const merged = mergeMessagesById(state.messages, response.messages, {
				preferIncoming: false,
			});

			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...state,
					messages: merged,
					hasMore: response.hasMore,
					loadingOlder: false,
					oldestCursor: response.hasMore && merged.length > 0
						? merged[0].sequence
						: undefined,
				},
			};

			// Restore scroll position after prepend
			await tick();
			chatTimelineRef?.finalizePrepend();
		} else {
			// No more messages
			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...state,
					hasMore: false,
					loadingOlder: false,
				},
			};
		}
	} catch (error) {
		sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				...state,
				loadingOlder: false,
				error: error instanceof Error ? error.message : "Failed to load older messages",
			},
		};
	}
}

/** Triggered by ChatTimeline when first visible index changes */
function handleFirstVisible(index: number) {
	if (!activeSessionId) return;
	const state = sessionStateById[activeSessionId];
	if (!state || !state.hasMore || state.loadingOlder) return;

	const unseenTopCount = index;
	if (unseenTopCount <= PRELOAD_THRESHOLD && !preloadingSessionIds.has(activeSessionId)) {
		const sid = activeSessionId;
		preloadingSessionIds.add(sid);
		loadOlderMessages(sid).finally(() => {
			preloadingSessionIds.delete(sid);
		});
	}
}

function shouldPollSpace(_space: SpaceRecord | null) {
	return false;
}

function getSpacePollInterval(_space: SpaceRecord | null) {
	return 3_000;
}

// ─── Share / Permissions ───

async function loadPermissions(force = false) {
	if (!force && spacePermissionsLoaded) return;
	// Mark as loading immediately so the $effect doesn't re-trigger
	// while the async call is in-flight.
	spacePermissionsLoaded = true;
	try {
		const perms = await spaceStore.ensureSpacePermissionRecords(spaceId, { force });
		spacePermissions = perms;
		spacePublicRead = perms.some((p) => p.resourceType === "space");
		spaceSessions = spaceStore.getSessions(spaceId) ?? spaceSessions;
	} catch {
		// Reset on failure so it can retry
		spacePermissionsLoaded = false;
		// Ignore — permissions may not exist yet
	}
}

async function toggleSpacePublicRead(enabled: boolean) {
	savingSpacePerm = true;
	try {
		if (enabled) {
			await createSpacePermission(spaceId, "read");
		} else {
			await deleteSpacePermission(spaceId);
		}
		spacePublicRead = enabled;
		await loadPermissions(true);
		notifyPermissionsUpdate();
	} catch {
		// Revert
		spacePublicRead = !enabled;
	} finally {
		savingSpacePerm = false;
	}
}

function openShareModal(sessionId: string) {
	shareModalSessionId = sessionId;
	shareCopied = false;
	showShareModal = true;
}

async function shareAndCopyLink() {
	if (!shareModalSessionId) return;
	shareModalError = "";
	shareModalSaving = true;
	try {
		await createSessionPermission(shareModalSessionId, "read");
		await loadPermissions(true);
		notifyPermissionsUpdate();
		const url = `${window.location.origin}/spaces/${spaceId}?session=${shareModalSessionId}`;
		await navigator.clipboard.writeText(url);
		shareCopied = true;
		if (shareCopiedTimer) clearTimeout(shareCopiedTimer);
		shareCopiedTimer = setTimeout(() => { shareCopied = false; }, 2000);
		showShareModal = false;
	} catch (error) {
		shareModalError = error instanceof Error ? error.message : "Failed to share session";
	} finally {
		shareModalSaving = false;
	}
}

async function makeSessionPrivate() {
	if (!shareModalSessionId) return;
	shareModalError = "";
	shareModalSaving = true;
	try {
		await createSessionPermission(shareModalSessionId, "private");
		await loadPermissions(true);
		notifyPermissionsUpdate();
		showShareModal = false;
	} catch (error) {
		shareModalError = error instanceof Error ? error.message : "Failed to make session private";
	} finally {
		shareModalSaving = false;
	}
}

async function removeSessionPermission(sessionId: string): Promise<boolean> {
	try {
		sessionPermError = "";
		await deleteSessionPermission(sessionId);
		await loadPermissions(true);
		notifyPermissionsUpdate();
		return true;
	} catch (error) {
		sessionPermError = error instanceof Error ? error.message : "Failed to remove permission";
		setTimeout(() => { sessionPermError = ""; }, 4000);
		return false;
	}
}

function hasSessionPermission(sessionId: string): boolean {
	return spacePermissions.some(
		(p) => p.resourceType === "session" && p.resourceId === sessionId && p.level !== "private",
	);
}

// ─── Collaborators ───

async function loadCollaborators(force = false) {
	if (!force && collaboratorsLoaded) return;
	loadingCollaborators = true;
	try {
		const perms = await listSpaceCollaborators(spaceId);
		spaceCollaborators = perms;
		collaboratorsLoaded = true;
	} catch {
		// ignore — collaborator endpoint requires auth; anonymous users stay read-only
	} finally {
		loadingCollaborators = false;
	}
}

async function handleAddCollaborator() {
	if (!addingCollaboratorUuid.trim() || savingCollaborator) return;
	savingCollaborator = true;
	addingCollaboratorError = "";
	try {
		await addSpaceCollaborator(spaceId, addingCollaboratorUuid.trim(), addingCollaboratorLevel);
		addingCollaboratorUuid = "";
		await loadCollaborators(true);
		notifyPermissionsUpdate();
	} catch (error) {
		addingCollaboratorError = error instanceof Error ? error.message : "Failed to add collaborator";
	} finally {
		savingCollaborator = false;
	}
}

async function handleUpdateCollaboratorLevel(granteeUuid: string, level: "read" | "write") {
	try {
		await updateSpaceCollaborator(spaceId, granteeUuid, level);
		await loadCollaborators(true);
		notifyPermissionsUpdate();
	} catch (error) {
		addingCollaboratorError = error instanceof Error ? error.message : "Failed to update collaborator";
	}
}

async function handleRemoveCollaborator(granteeUuid: string) {
	try {
		await removeSpaceCollaborator(spaceId, granteeUuid);
		await loadCollaborators(true);
		notifyPermissionsUpdate();
	} catch (error) {
		addingCollaboratorError = error instanceof Error ? error.message : "Failed to remove collaborator";
	}
}

// ─── SSE streaming (per-session) ───

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 15000;
const HIDDEN_TAB_MIN_RECONNECT_DELAY_MS = 5000;

function clearStreamingState() {
	streamingAssistantText = "";
	streamingThinking = "";
	streamingContentBlocks = [];
	streamingSessionId = null;
}

function clearReconnectTimer(sessionId: string) {
	const timer = sessionReconnectTimers.get(sessionId);
	if (timer) {
		clearTimeout(timer);
		sessionReconnectTimers.delete(sessionId);
	}
}

function shouldKeepSessionSSE(sessionId: string) {
	return pageMounted && pageOnline && activeSessionId === sessionId;
}

function scheduleSessionReconnect(sessionId: string) {
	if (!shouldKeepSessionSSE(sessionId)) return;
	if (sessionSSEs.has(sessionId) || sessionReconnectTimers.has(sessionId)) return;

	const attempt = (sessionReconnectAttempts.get(sessionId) ?? 0) + 1;
	sessionReconnectAttempts.set(sessionId, attempt);

	const expDelay = Math.min(
		BASE_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1),
		MAX_RECONNECT_DELAY_MS,
	);
	const delay = pageVisible
		? expDelay
		: Math.max(expDelay, HIDDEN_TAB_MIN_RECONNECT_DELAY_MS);

	const timer = setTimeout(() => {
		sessionReconnectTimers.delete(sessionId);
		if (shouldKeepSessionSSE(sessionId)) {
			connectSessionSSE(sessionId);
		}
	}, delay);

	sessionReconnectTimers.set(sessionId, timer);
}

function ensureSessionSSE(sessionId: string) {
	clearReconnectTimer(sessionId);
	if (!shouldKeepSessionSSE(sessionId)) return;
	if (sessionSSEs.has(sessionId)) return;
	connectSessionSSE(sessionId);
}

// Process events sequentially to avoid race conditions
async function processEventQueue() {
	if (eventProcessing || eventQueue.length === 0) return;
	eventProcessing = true;

	while (eventQueue.length > 0) {
		const event = eventQueue.shift();
		if (!event) continue;
		const currentActiveSessionId = activeSessionId;
		if (
			currentActiveSessionId == null ||
			event.sessionId !== currentActiveSessionId
		)
			continue;

		if (event.type === "stream_update") {
			const { thinking, answer } = extractSessionRenderState(
				event.content,
			);
			streamingThinking = thinking;
			streamingAssistantText = answer;
			streamingContentBlocks = event.content;
			const hasStreamingContent = event.content.length > 0;
			if (hasStreamingContent) {
				if (streamingSessionId !== currentActiveSessionId) {
					streamingSessionId = currentActiveSessionId;
					notifyStreamingStatus(currentActiveSessionId, true);
				}
				// No manual scroll needed: column-reverse + scroll anchoring keeps
				// the view pinned to the bottom automatically.
			}

			if (event.turnEnd) {
				// Sync with persisted server messages. Use a retry loop because
				// the agent enqueues persistence asynchronously — turnEnd may
				// fire before DB writes complete.
				const state = sessionStateById[currentActiveSessionId];
				let newMessages: MessageRecord[] = [];
				let updatedSession = state?.session;

				try {
					const prevSeq = state?.messages.length >= 2
						? state.messages.at(-2)?.sequence ?? 0
						: 0;

					// Retry up to 3 times with 300ms backoff to give the agent's
					// persistence queue time to flush to the API database.
					for (let attempt = 1; attempt <= 3; attempt++) {
						const response = await getSessionMessagesPaginated(currentActiveSessionId, {
							cursor: prevSeq,
							direction: "newer",
							limit: 100,
						});
						if (response.messages.length > 0) {
							newMessages = response.messages;
							updatedSession = response.session;
							break;
						}
						if (attempt < 3) {
							await new Promise((r) => setTimeout(r, 300));
						}
					}

					// Fallback: if retry didn't find messages, the agent's persistence
					// may still be writing (especially for turns with many tool calls).
					// Wait longer then fetch latest messages directly.
					if (newMessages.length === 0) {
						await new Promise((r) => setTimeout(r, 2000));
						const response = await getSessionMessagesPaginated(currentActiveSessionId, {
							limit: 100,
						});
						if (response.messages.length > 0) {
							newMessages = response.messages;
							updatedSession = response.session;
						}
					}

					// Update cache with server-persisted messages (user + assistant).
					if (newMessages.length > 0) {
						await messageCache.append(currentActiveSessionId, newMessages);
					}
				} catch {
					// Ignore sync errors, keep existing messages
				}

				// Atomically replace streaming content with persisted messages.
				// Single-tick state batch ensures $derived timeline recalculates once.
				streamingAssistantText = "";
				streamingThinking = "";
				streamingContentBlocks = [];
				streamStatus = "done";
				if (streamingSessionId) {
					notifyStreamingStatus(streamingSessionId, false);
				}
				streamingSessionId = null;

				// Merge new messages with existing ones, replacing optimistic copies with persisted versions.
				const existingMessages = state?.messages ?? [];
				const merged = mergeMessagesById(existingMessages, newMessages, {
					preferIncoming: true,
				});

				sessionStateById = {
					...sessionStateById,
					[currentActiveSessionId]: {
						session: updatedSession ?? state?.session,
						messages: merged,
						loading: false,
						loaded: true,
						error: "",
						hasMore: state?.hasMore ?? true,
						loadingOlder: false,
						oldestCursor: state?.oldestCursor,
					},
				};

				// column-reverse + scroll anchoring keeps the view pinned to
				// the bottom automatically — no manual scroll needed.
			}
		}
	}

	eventProcessing = false;
	if (eventQueue.length > 0) {
		void processEventQueue();
	}
}

// Start SSE for a specific session
function connectSessionSSE(sessionId: string) {
	disconnectSessionSSE(sessionId);
	clearReconnectTimer(sessionId);
	if (!shouldKeepSessionSSE(sessionId)) return;

	const abort = new AbortController();
	sessionSSEs.set(sessionId, abort);
	const lastEventId = sessionLastEventIds.get(sessionId);

	(async () => {
		let shouldReconnect = true;
		try {
			for await (const packet of streamSessionEvents(
				sessionId,
				lastEventId,
				abort.signal,
			)) {
				if (packet.id) {
					sessionLastEventIds.set(sessionId, packet.id);
				}
				sessionReconnectAttempts.set(sessionId, 0);
				eventQueue.push(packet.event);
				void processEventQueue();
			}
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				shouldReconnect = false;
				return;
			}
			console.error(`[SSE] Session ${sessionId} stream error:`, error);
		} finally {
			sessionSSEs.delete(sessionId);
			if (shouldReconnect && shouldKeepSessionSSE(sessionId)) {
				scheduleSessionReconnect(sessionId);
			}
		}
	})();
}

// Disconnect SSE for a specific session
function disconnectSessionSSE(sessionId: string) {
	clearReconnectTimer(sessionId);
	const existing = sessionSSEs.get(sessionId);
	if (existing) {
		existing.abort();
		sessionSSEs.delete(sessionId);
	}
}

// Disconnect all SSE connections
function disconnectAllSSE() {
	for (const timer of sessionReconnectTimers.values()) {
		clearTimeout(timer);
	}
	sessionReconnectTimers.clear();
	for (const [, ctrl] of sessionSSEs) {
		ctrl.abort();
	}
	sessionSSEs.clear();
	eventQueue = [];
	eventProcessing = false;
}

async function handleSend() {
	if (
		!activeSessionState ||
		(!input.trim() && imageAttachments.length === 0) ||
		sending ||
		!space
	)
		return;
	sending = true;
	streamError = "";
	streamStatus = "streaming";

	const text = input.trim();
	const attachmentBlocks: ContentBlock[] = imageAttachments.map((attachment) => ({
		type: "image",
		source: {
			type: "base64",
			media_type: attachment.mediaType,
			data: attachment.data,
		},
		_meta: {
			filename: attachment.name,
			size: attachment.size,
		},
	}));
	const content: ContentBlock[] = [
		...attachmentBlocks,
		...(text ? [{ type: "text", text } satisfies ContentBlock] : []),
	];
	const sessionId = activeSessionState.session.id;

	try {
		// Get server-assigned userMessageId BEFORE showing optimistic message
		const model = activeSessionModel;
		const result = await postSessionMessage(sessionId, content, {
			model: model?.id,
			provider: model?.provider,
		});
		const userMessageId = result?.userMessageId;

		input = "";
		imageAttachments = [];
		clearStreamingState();

		const currentState = sessionStateById[sessionId];
		if (currentState) {
			const optimisticMessage = {
				id: userMessageId || `optimistic-user-${Date.now()}`,
				sessionId,
				role: "user" as const,
				content,
				text,
				sequence: (currentState.messages.at(-1)?.sequence ?? 0) + 1,
				provider: null,
				model: null,
				stopReason: null,
				errorMessage: null,
				usageInput: null,
				usageOutput: null,
				costTotal: null,
				meta: null,
				createdAt: new Date().toISOString(),
			} satisfies MessageRecord;

			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...currentState,
					messages: [...currentState.messages, optimisticMessage],
				},
			};

			// Persist optimistic user message to IndexedDB immediately so it
			// survives page reload. Without this, turnEnd's server-side fetch
			// (sequence > cursor) skips it, and the cache ends up missing the
			// user message permanently.
			await messageCache.append(sessionId, [optimisticMessage]);
		}
	} catch (error) {
		streamError =
			error instanceof Error ? error.message : "Failed to send message";
		streamStatus = "error";
		clearStreamingState();
		await loadSessionState(sessionId, true).catch(() => undefined);
	} finally {
		sending = false;
	}
}

// In column-reverse: the scroll coordinate system is unchanged — scrollTop=0 is
// the visual top, scrollTop=max is the visual bottom. The benefit of column-reverse
// is that when content is added at the DOM START (new messages), CSS scroll
// anchoring keeps the viewport pinned to the bottom automatically.
//
// scrollToBottom: explicitly set scrollTop to max. Uses rAF retries because
// markdown rendering / image loading can change scrollHeight asynchronously.
function scrollToBottom() {
	if (!listEl) return;
	hasScrolledUp = false;
	const doScroll = (retries = 5) => {
		requestAnimationFrame(() => {
			if (!listEl) return;
			listEl.scrollTop = listEl.scrollHeight - listEl.clientHeight;
			if (retries > 0) {
				doScroll(retries - 1);
			} else {
				updateScrollState();
			}
		});
	};
	doScroll();
}

function updateScrollState() {
	if (!listEl) return;
	// In column-reverse the scroll coordinate is standard:
	// scrollTop=0 = visual top, scrollTop=max = visual bottom.
	// Only write to $state when the value actually changes to avoid unnecessary
	// Svelte reactivity updates on every scroll event tick.
	const threshold = 80;
	const distanceFromBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
	const scrolledUp = distanceFromBottom > threshold;
	if (scrolledUp !== hasScrolledUp) {
		hasScrolledUp = scrolledUp;
	}
	const shouldShow = hasScrolledUp && listEl.scrollHeight > listEl.clientHeight + 24;
	if (shouldShow !== showScrollToBottom) {
		showScrollToBottom = shouldShow;
	}
}

async function fileToDataUrl(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ""));
		reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
		reader.readAsDataURL(file);
	});
}

async function loadImageElement(file: File): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const objectUrl = URL.createObjectURL(file);
		const image = new Image();
		image.onload = () => {
			URL.revokeObjectURL(objectUrl);
			resolve(image);
		};
		image.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			reject(new Error("Failed to decode image"));
		};
		image.src = objectUrl;
	});
}

async function canvasToWebpBlob(
	canvas: HTMLCanvasElement,
	quality: number,
): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error("Failed to encode image"));
			},
			"image/webp",
			quality,
		);
	});
}

async function compressImageFile(file: File): Promise<{
	blob: Blob;
	dataUrl: string;
	mediaType: string;
	size: number;
}> {
	const image = await loadImageElement(file);
	const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
	const scale = longestEdge > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longestEdge : 1;
	const width = Math.max(1, Math.round(image.naturalWidth * scale));
	const height = Math.max(1, Math.round(image.naturalHeight * scale));

	const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Canvas is not supported");
	context.drawImage(image, 0, 0, width, height);

	let blob = await canvasToWebpBlob(canvas, WEBP_QUALITIES[0]);
	for (const quality of WEBP_QUALITIES.slice(1)) {
		if (blob.size <= MAX_IMAGE_BYTES) break;
		blob = await canvasToWebpBlob(canvas, quality);
	}

	if (blob.size > MAX_IMAGE_BYTES) {
		throw new Error("Image is too large after compression");
	}

	const dataUrl = await fileToDataUrl(blob);
	return {
		blob,
		dataUrl,
		mediaType: "image/webp",
		size: blob.size,
	};
}

async function handlePickImages(files: FileList | File[] | null) {
	if (!files) return;
	const validFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
	if (validFiles.length === 0) return;

	try {
		const nextAttachments = await Promise.all(
			validFiles.map(async (file) => {
				const compressed = await compressImageFile(file);
				const [, base64 = ""] = compressed.dataUrl.split(",");
				const webpName = file.name.replace(/\.[^.]+$/, "") || file.name;
				return {
					id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
					name: `${webpName}.webp`,
					mediaType: compressed.mediaType,
					data: base64,
					previewUrl: compressed.dataUrl,
					size: compressed.size,
				} satisfies ComposerImageAttachment;
			}),
		);
		imageAttachments = [...imageAttachments, ...nextAttachments];
	} catch (error) {
		streamError = error instanceof Error ? error.message : "Failed to read image";
	}
}

function handleRemoveAttachment(id: string) {
	imageAttachments = imageAttachments.filter((attachment) => attachment.id !== id);
}

function beginRightSidebarResize(event: PointerEvent) {
	event.preventDefault();
	if (window.innerWidth < 1280 || uiState.rightSidebarCollapsed) return;

	rightSidebarResizeCleanup?.();

	const startX = event.clientX;
	const startWidth = uiState.rightSidebarWidth;
	const minMainWidth = 720;

	const onPointerMove = (moveEvent: PointerEvent) => {
		const delta = startX - moveEvent.clientX;
		const viewportLimit = window.innerWidth - minMainWidth;
		const nextWidth = Math.min(
			RIGHT_SIDEBAR_MAX,
			Math.max(RIGHT_SIDEBAR_MIN, Math.min(startWidth + delta, viewportLimit)),
		);
		uiState.setRightSidebarWidth(nextWidth);
	};

	const stop = () => {
		document.body.classList.remove("sidebar-resizing");
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", stop);
		window.removeEventListener("pointercancel", stop);
		if (rightSidebarResizeCleanup === stop) {
			rightSidebarResizeCleanup = null;
		}
	};

	rightSidebarResizeCleanup = stop;
	document.body.classList.add("sidebar-resizing");
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", stop);
	window.addEventListener("pointercancel", stop);
}

// ─── Mobile right drawer gestures (mirrors left-drawer logic in +layout.svelte) ───

let rightDrawerGesturePhase = $state<DrawerGesturePhase>("idle");
let rightDrawerGestureDirection = $state<DrawerGestureDirection>(null);
let rightDrawerActiveTouchId = $state<number | null>(null);
let rightDrawerPointerStartX = $state(0);
let rightDrawerPointerStartY = $state(0);
let rightDrawerLastPointerX = $state(0);
let rightDrawerLastPointerTime = $state(0);
let rightDrawerDragOffsetPx = $state(0);
let rightDrawerVelocityX = $state(0);
let rightDrawerIsDragging = $state(false);
let rightDrawerIsVisible = $state(false);

function rightDrawerResetGesture() {
	rightDrawerGesturePhase = "idle";
	rightDrawerGestureDirection = null;
	rightDrawerActiveTouchId = null;
	rightDrawerPointerStartX = 0;
	rightDrawerPointerStartY = 0;
	rightDrawerLastPointerX = 0;
	rightDrawerLastPointerTime = 0;
	rightDrawerDragOffsetPx = 0;
	rightDrawerVelocityX = 0;
	rightDrawerIsDragging = false;
}

function rightDrawerFindTrackedTouch(touches: TouchList) {
	if (rightDrawerActiveTouchId === null) return null;
	for (const touch of Array.from(touches)) {
		if (touch.identifier === rightDrawerActiveTouchId) return touch;
	}
	return null;
}

function rightDrawerBeginSettling(open: boolean) {
	rightDrawerGesturePhase = "settling";
	uiState.mobileRightDrawerOpen = open;
	rightDrawerIsDragging = false;
	rightDrawerActiveTouchId = null;
	rightDrawerGestureDirection = null;
	rightDrawerVelocityX = 0;
	rightDrawerLastPointerTime = 0;
	rightDrawerLastPointerX = 0;
	rightDrawerPointerStartX = 0;
	rightDrawerPointerStartY = 0;
}

function rightDrawerHandleTouchStart(e: TouchEvent) {
	if (window.innerWidth >= 1024 || rightDrawerActiveTouchId !== null) return;
	const touch = e.changedTouches[0];
	if (!touch) return;

	if (
		!shouldStartRightDrawerGesture({
			isOpen: uiState.mobileRightDrawerOpen,
			target: e.target,
			viewportWidth: window.innerWidth,
			touchStartX: touch.clientX,
			otherDrawerOpen: uiState.mobileDrawerOpen,
		})
	) {
		return;
	}

	rightDrawerActiveTouchId = touch.identifier;
	rightDrawerGesturePhase = "tracking";
	rightDrawerGestureDirection = null;
	rightDrawerPointerStartX = touch.clientX;
	rightDrawerPointerStartY = touch.clientY;
	rightDrawerLastPointerX = touch.clientX;
	rightDrawerLastPointerTime = e.timeStamp;
	rightDrawerDragOffsetPx = uiState.mobileRightDrawerOpen ? MOBILE_DRAWER_WIDTH_PX : 0;
	rightDrawerVelocityX = 0;
	rightDrawerIsDragging = false;
}

function rightDrawerHandleTouchMove(e: TouchEvent) {
	const touch = rightDrawerFindTrackedTouch(e.touches);
	if (!touch) return;

	const dx = touch.clientX - rightDrawerPointerStartX;
	const dy = touch.clientY - rightDrawerPointerStartY;
	const absDx = Math.abs(dx);
	const absDy = Math.abs(dy);

	if (rightDrawerGestureDirection === null) {
		const resolvedDirection = resolveDrawerGestureDirection({ absDx, absDy });
		if (resolvedDirection === null) return;
		if (resolvedDirection === "vertical") {
			rightDrawerResetGesture();
			return;
		}
		rightDrawerGestureDirection = resolvedDirection;
	}

	const deltaTime = Math.max(e.timeStamp - rightDrawerLastPointerTime, 1);
	rightDrawerVelocityX = (touch.clientX - rightDrawerLastPointerX) / deltaTime;
	rightDrawerLastPointerX = touch.clientX;
	rightDrawerLastPointerTime = e.timeStamp;

	const nextOffsetPx = getRightDrawerOffsetFromDrag({
		isOpen: uiState.mobileRightDrawerOpen,
		deltaX: dx,
	});

	if (!uiState.mobileRightDrawerOpen && nextOffsetPx <= 0) return;
	// When open, positive deltaX (swipe right towards edge) reduces offset;
	// negative deltaX (swipe left into screen) increases offset, capped at max.
	if (uiState.mobileRightDrawerOpen && nextOffsetPx >= MOBILE_DRAWER_WIDTH_PX && dx <= 0) return;

	rightDrawerIsDragging = true;
	rightDrawerDragOffsetPx = nextOffsetPx;
	rightDrawerGesturePhase = uiState.mobileRightDrawerOpen ? "dragging-close" : "dragging-open";

	if (e.cancelable) {
		e.preventDefault();
	}
}

function rightDrawerFinalizeGesture() {
	if (!rightDrawerIsDragging) {
		rightDrawerResetGesture();
		return;
	}

	const shouldOpen = uiState.mobileRightDrawerOpen
		? shouldKeepRightDrawerOpen({ offsetPx: rightDrawerDragOffsetPx, velocityX: rightDrawerVelocityX })
		: shouldOpenRightDrawer({ offsetPx: rightDrawerDragOffsetPx, velocityX: rightDrawerVelocityX });

	rightDrawerBeginSettling(shouldOpen);
}

function rightDrawerHandleTouchEnd(e: TouchEvent) {
	const touch = rightDrawerFindTrackedTouch(e.changedTouches);
	if (!touch) return;
	rightDrawerFinalizeGesture();
}

function rightDrawerHandleTouchCancel(e: TouchEvent) {
	const touch = rightDrawerFindTrackedTouch(e.changedTouches);
	if (!touch) return;
	rightDrawerFinalizeGesture();
}

onMount(() => {
	uiState.loadLayoutPrefs();
	pageMounted = true;
	pageVisible = document.visibilityState === "visible";
	pageOnline = typeof navigator === "undefined" ? true : navigator.onLine;
	// Preload model catalog so the composer shows a default model immediately
	void loadModelsCatalog();
	void authStore.ensureLoaded().then(() => {
		if (space) {
			isOwner = space.userUuid === authStore.userUuid;
		}
	});

	function handleVisibilityChange() {
		pageVisible = document.visibilityState === "visible";
		if (activeSessionId && pageVisible) {
			ensureSessionSSE(activeSessionId);
		}
	}

	function handleOnline() {
		pageOnline = true;
		if (activeSessionId) {
			ensureSessionSSE(activeSessionId);
		}
	}

	function handleOffline() {
		pageOnline = false;
		if (activeSessionId) {
			disconnectSessionSSE(activeSessionId);
		}
	}

	window.addEventListener("online", handleOnline);
	window.addEventListener("offline", handleOffline);
	window.addEventListener("keydown", handleFileKeyboardSave);
	document.addEventListener("visibilitychange", handleVisibilityChange);

	// Mobile right drawer touch gestures
	function onRightDrawerTouchStart(e: TouchEvent) {
		rightDrawerHandleTouchStart(e);
	}
	function onRightDrawerTouchMove(e: TouchEvent) {
		rightDrawerHandleTouchMove(e);
	}
	function onRightDrawerTouchEnd(e: TouchEvent) {
		rightDrawerHandleTouchEnd(e);
	}
	function onRightDrawerTouchCancel(e: TouchEvent) {
		rightDrawerHandleTouchCancel(e);
	}

	document.addEventListener("touchstart", onRightDrawerTouchStart, { passive: true });
	document.addEventListener("touchmove", onRightDrawerTouchMove, { passive: false });
	document.addEventListener("touchend", onRightDrawerTouchEnd, { passive: true });
	document.addEventListener("touchcancel", onRightDrawerTouchCancel, { passive: true });

	// Initialize broadcast channel for cross-component communication
	try {
		broadcastChannel = new BroadcastChannel(`cohub:space:${spaceId}`);
	} catch {
		// BroadcastChannel not supported, fallback to window events
	}

	void loadSpace({ force: true }).finally(() => {
		void loadFileTree(true);
		if (authStore.isAuthenticated) {
			void loadPermissions(true).finally(() => {
				bootstrapping = false;
			});
		} else {
			bootstrapping = false;
		}
	});

	// Polling is handled by the $effect below to avoid competing timer
	// mechanisms. The $effect re-schedules whenever space state changes,
	// so no recursive self-scheduling is needed here.

	return () => {
		rightSidebarResizeCleanup?.();
		document.body.classList.remove("sidebar-resizing");
		pageMounted = false;
		if (spacePollingTimer) clearTimeout(spacePollingTimer);
		window.removeEventListener("online", handleOnline);
		window.removeEventListener("offline", handleOffline);
		window.removeEventListener("keydown", handleFileKeyboardSave);
		document.removeEventListener("visibilitychange", handleVisibilityChange);
		// Mobile right drawer gesture cleanup
		document.removeEventListener("touchstart", onRightDrawerTouchStart);
		document.removeEventListener("touchmove", onRightDrawerTouchMove);
		document.removeEventListener("touchend", onRightDrawerTouchEnd);
		document.removeEventListener("touchcancel", onRightDrawerTouchCancel);
		disconnectAllSSE();
		broadcastChannel?.close();
		broadcastChannel = null;
	};
});

// Manage SSE connection lifecycle based on active session
let prevActiveSessionId: string | null = null;
$effect(() => {
	const currentId = activeSessionId;

	// Disconnect SSE for sessions that are no longer active
	for (const [id] of sessionSSEs) {
		if (id !== currentId) {
			disconnectSessionSSE(id);
		}
	}
	for (const [id] of sessionReconnectTimers) {
		if (id !== currentId) {
			clearReconnectTimer(id);
		}
	}

	// Ensure the active session always has exactly one live stream or pending reconnect
	if (currentId) {
		ensureSessionSSE(currentId);
	}

	// Clear streaming state when switching sessions
	if (prevActiveSessionId && prevActiveSessionId !== currentId) {
		clearStreamingState();
	}
	prevActiveSessionId = currentId;
});

// Sync mobile right drawer visibility + settling animation
$effect(() => {
	if (rightDrawerGesturePhase === "settling") {
		// Keep visible during settle animation
		rightDrawerIsVisible = true;
		return;
	}
	if (uiState.mobileRightDrawerOpen || rightDrawerIsDragging) {
		rightDrawerIsVisible = true;
		return;
	}
	rightDrawerIsVisible = false;
});

$effect(() => {
	if (rightDrawerGesturePhase !== "settling") return;

	const timer = window.setTimeout(() => {
		if (rightDrawerGesturePhase === "settling") {
			rightDrawerGesturePhase = "idle";
			if (!uiState.mobileRightDrawerOpen) {
				rightDrawerDragOffsetPx = 0;
			}
		}
	}, 220);

	return () => window.clearTimeout(timer);
});

// Lock body scroll when right drawer is open
$effect(() => {
	if (uiState.mobileRightDrawerOpen || rightDrawerIsDragging) {
		document.body.classList.add("drawer-open");
	} else {
		document.body.classList.remove("drawer-open");
	}
});

// Close mobile right drawer on Escape
$effect(() => {
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && uiState.mobileRightDrawerOpen) {
			uiState.mobileRightDrawerOpen = false;
		}
	}
	window.addEventListener("keydown", handleKeydown);
	return () => window.removeEventListener("keydown", handleKeydown);
});

// Close more menu on click outside
$effect(() => {
	function handleClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest("[data-more-menu]")) {
			showMoreMenu = false;
		}
	}
	document.addEventListener("click", handleClick);
	return () => document.removeEventListener("click", handleClick);
});

$effect(() => {
	if (activeSessionId) {
		void loadSessionState(activeSessionId).finally(() => {
			bootstrapping = false;
		});
	}
});

// Scroll position tracking — detect when user has scrolled away from bottom.
$effect(() => {
	const el = listEl;
	if (!el) return;

	function handleScroll() {
		updateScrollState();
	}

	el.addEventListener("scroll", handleScroll, { passive: true });
	return () => el.removeEventListener("scroll", handleScroll);
});

// On session data ready: scroll to bottom on first visit.
// With column-reverse, scroll anchoring keeps the view pinned to the bottom
// as new content arrives, but we must explicitly scroll there once after
// the initial content renders (markdown, images, etc can change scrollHeight).
let prevSessionForScroll = $state<string | null>(null);

$effect(() => {
	const sessionId = activeSessionId;
	if (!sessionId || !listEl) return;

	const state = sessionStateById[sessionId];
	if (!state?.loaded) return;

	// Only scroll to bottom on first visit to this session (not on re-renders)
	if (prevSessionForScroll !== sessionId) {
		prevSessionForScroll = sessionId;
		hasScrolledUp = false;
		scrollToBottom();
	}
});

// Auto-scroll when new content arrives during streaming and user hasn't scrolled up.
// In column-reverse, scroll anchoring handles most cases, but we need an explicit
// trigger when the timeline grows to ensure the view stays at the bottom.
$effect(() => {
	// React to timeline length changes (new messages added)
	const _len = timeline.length;
	if (!listEl || hasScrolledUp) return;

	requestAnimationFrame(() => {
		if (listEl && !hasScrolledUp) {
			scrollToBottom();
		}
	});
});

$effect(() => {
	if (showSettings && !spaceStore.hasLoadedChannels(spaceId) && !loadingChannels) {
		loadingChannels = true;
		void spaceStore.ensureSpaceChannels(spaceId).then((channels) => {
			spaceChannels = channels;
		}).finally(() => {
			loadingChannels = false;
		});
	}
	if (showSettings && authStore.isAuthenticated && !spacePermissionsLoaded && !loadingPermissions) {
		loadingPermissions = true;
		void loadPermissions().finally(() => {
			loadingPermissions = false;
		});
	}
	// Load collaborators for owner (to manage them) and for non-owners
	// (so canWrite derivation knows if they have write access).
	if (authStore.isAuthenticated && !collaboratorsLoaded && !loadingCollaborators) {
		loadingCollaborators = true;
		void loadCollaborators().finally(() => {
			loadingCollaborators = false;
		});
	}
});

$effect(() => {
	if (spacePollingTimer) {
		clearTimeout(spacePollingTimer);
		spacePollingTimer = null;
	}
	if (!shouldPollSpace(space)) return;
	const timer = setTimeout(async () => {
		// Don't use force:true for polling — the store's shouldRefresh
		// checks are sufficient and prevent request storms when multiple
		// consumers (sidebar, page) poll simultaneously.
		await loadSpace();
	}, getSpacePollInterval(space));
	spacePollingTimer = timer;
	return () => {
		clearTimeout(timer);
		if (spacePollingTimer === timer) {
			spacePollingTimer = null;
		}
	};
});
</script>

<!-- Space Header -->
<PageHeader>
  {#snippet left()}
    <div class="flex items-center gap-2 min-w-0">
      <Terminal class="w-3.5 h-3.5 text-text-tertiary shrink-0 hidden sm:block" />
      <span class="text-[13px] text-text-primary truncate">{space?.name || space?.id || spaceId}</span>
    </div>
  {/snippet}
  {#snippet right()}
    {#if canWrite}
    <button
      type="button"
      class="flex items-center gap-1.5 px-2 h-8 rounded-[5px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100 disabled:opacity-50"
      onclick={() => handleCreateNewSession()}
      disabled={creatingSession || !space}
      title="New session"
    >
      {#if creatingSession}
        <div class="w-3.5 h-3.5 rounded-full border-2 border-border-subtle border-t-brand animate-spin shrink-0"></div>
      {:else}
        <Plus class="w-4 h-4 shrink-0" />
      {/if}
      <span class="hidden lg:inline text-[13px] font-medium">New session</span>
    </button>
    {/if}

    <!-- Session Share -->
    {#if activeSessionId && isOwner}
      {@const isPublic = hasSessionPermission(activeSessionId)}
      <button
        type="button"
        class="flex items-center gap-1.5 px-2 h-8 rounded-[5px] transition-colors duration-100 {isPublic ? 'text-success-soft hover:text-success hover:bg-success-bg' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'}"
        onclick={() => { openShareModal(activeSessionId!); }}
        title={isPublic ? 'Session is public' : 'Share session'}
      >
        {#if isPublic}
          <Globe class="w-4 h-4 shrink-0" />
          <span class="hidden lg:inline text-[13px] font-medium">Shared</span>
        {:else}
          <Share2 class="w-4 h-4 shrink-0" />
          <span class="hidden lg:inline text-[13px] font-medium">Share</span>
        {/if}
      </button>
    {/if}

    <!-- More menu (owner only) -->
    {#if isOwner}
    <div class="relative" data-more-menu>
      <button
        type="button"
        class="flex items-center justify-center w-8 h-8 rounded-[5px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
        onclick={() => showMoreMenu = !showMoreMenu}
        title="More"
      >
        <MoreVertical class="w-4 h-4" />
      </button>

      {#if showMoreMenu}
        <div
          class="absolute right-0 top-full mt-1 w-48 bg-bg-primary border border-border-subtle rounded-md shadow-lg overflow-hidden z-50"
        >
          <button
            type="button"
            class="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            onclick={() => { showSettings = true; showMoreMenu = false; }}
          >
            <Settings class="w-3.5 h-3.5" />
            <span>Settings</span>
          </button>
          <button
            type="button"
            class="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-error-soft hover:text-error hover:bg-bg-hover transition-colors disabled:opacity-50"
            disabled={spaceActionInProgress !== null}
            onclick={() => { void handleDelete(); showMoreMenu = false; }}
          >
            {#if spaceActionInProgress === "delete"}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
            {:else}
              <Trash2 class="w-3.5 h-3.5" />
            {/if}
            <span>Delete space</span>
          </button>
        </div>
      {/if}
    </div>
    {/if}

    <!-- Toggle right sidebar -->
    <div class="relative">
      <button
        type="button"
        class="flex items-center gap-1.5 px-2 h-8 rounded-[5px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
        onclick={() => {
          if (!canWrite) {
            triggerNoWriteHint();
            return;
          }
          if (window.innerWidth < 1024) {
            uiState.mobileRightDrawerOpen = !uiState.mobileRightDrawerOpen;
          } else {
            uiState.toggleRightSidebarCollapsed();
          }
        }}
        title={uiState.rightSidebarCollapsed ? "Show files" : "Hide files"}
        aria-label={uiState.rightSidebarCollapsed ? "Show files" : "Hide files"}
      >
        {#if uiState.rightSidebarCollapsed}
          <PanelRightOpen class="w-4 h-4 shrink-0" />
          <span class="hidden 2xl:inline text-[13px] font-medium">Show files</span>
        {:else}
          <PanelRightClose class="w-4 h-4 shrink-0" />
          <span class="hidden 2xl:inline text-[13px] font-medium">Hide files</span>
        {/if}
      </button>

      {#if showNoWriteHint}
        <div class="hint-toast">
          <span>Read-only — you don't have write access to this space</span>
        </div>
      {/if}
    </div>
  {/snippet}
</PageHeader>

<!-- Space action error banner -->
{#if spaceActionError}
  <div class="flex items-center justify-between px-3 py-2 border-b border-error-soft/30 bg-error-bg shrink-0">
    <span class="text-[12px] font-mono text-error-soft truncate mr-2">{spaceActionError}</span>
    <button onclick={() => spaceActionError = ""} class="text-text-tertiary hover:text-text-secondary shrink-0" title="Dismiss">
      <X class="w-3 h-3" />
    </button>
  </div>
{/if}

<!-- Main Content -->
<div class="flex-1 flex min-h-0">
  <div class="flex-1 flex flex-col min-w-0 bg-bg-content">

  {#if !uiState.rightSidebarCollapsed}
    <div class="hidden shrink-0 xl:block relative border-l border-border-subtle" style={`width: ${uiState.rightSidebarWidth}px`}>
      <SpaceFileSidebar
        nodes={fileTree}
        selectedPath={urlFilePath ?? ""}
        loading={fileTreeLoading}
        error={fileTreeError}
        onToggle={handleFileToggle}
        onSelect={handleFileSelect}
        onRefresh={refreshFileTree}
        onCreateFile={handleCreateFile}
        onCreateDir={handleCreateDir}
        onRename={handleRenameNode}
        onDelete={handleDeleteNode}
        canWrite={canWrite}
      />
      <button
        type="button"
        class="right-sidebar-resize-handle"
        aria-label="Resize files sidebar"
        title="Resize files sidebar"
        onpointerdown={beginRightSidebarResize}
      ></button>
    </div>
  {/if}

  <!-- Settings Overlay (desktop: right drawer, mobile: bottom sheet) -->
  <SettingsOverlay open={showSettings} onClose={() => showSettings = false}>
    <div class="p-4 space-y-6">
      <!-- Sharing section -->
      <section class="space-y-3">
        <div class="text-[10px] font-bold text-text-tertiary uppercase tracking-widest flex items-center justify-between">
          <span>Sharing</span>
        </div>

        <!-- Space-level toggle -->
        <label class="flex items-start gap-3 cursor-pointer group p-2 rounded-[5px] hover:bg-bg-hover transition-colors">
          <div class="relative shrink-0 mt-0.5">
            <input
              type="checkbox"
              checked={spacePublicRead}
              onchange={(event) => { void toggleSpacePublicRead((event.currentTarget as HTMLInputElement).checked); }}
              disabled={savingSpacePerm}
              class="sr-only peer"
            />
            <div class="w-8 h-[18px] rounded-full bg-bg-hover-strong peer-checked:bg-brand transition-colors duration-150"></div>
            <div class="absolute left-0.5 top-0.5 w-[13px] h-[13px] rounded-full bg-text-tertiary peer-checked:bg-white peer-checked:left-[15px] transition-all duration-150"></div>
          </div>
          <div class="flex flex-col min-w-0">
            <span class="text-[13px] text-text-secondary group-hover:text-text-primary transition-colors font-medium">Public read</span>
            <span class="text-[11px] text-text-placeholder">Anyone with the link can view all sessions</span>
          </div>
        </label>

        <div class="w-full h-px bg-border-subtle"></div>

        <!-- Session-level permissions -->
        <div class="space-y-1">
          <div class="text-[11px] text-text-placeholder px-2">Session access</div>
          {#each sharedSessionPermissions as perm (perm.id)}
            <div class="flex items-center gap-2 px-2 py-1.5 rounded-[4px] group">
              {#if perm.level === 'write'}
                <Share2 class="w-3.5 h-3.5 text-brand shrink-0" />
              {:else if perm.level === 'private'}
                <Lock class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
              {:else}
                <Globe class="w-3.5 h-3.5 text-text-secondary shrink-0" />
              {/if}
              <span class="text-[12.5px] text-text-secondary truncate flex-1">
                {sessionTitleById.get(perm.resourceId) || 'Session ' + perm.resourceId.slice(0, 8)}
              </span>
              <div class="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  class="p-1 rounded-sm text-text-tertiary hover:text-brand hover:bg-bg-hover transition-colors opacity-0 group-hover:opacity-100"
                  onclick={() => {
                    const url = `${window.location.origin}/spaces/${spaceId}?session=${perm.resourceId}`;
                    void navigator.clipboard.writeText(url);
                    shareCopied = true;
                    if (shareCopiedTimer) clearTimeout(shareCopiedTimer);
                    shareCopiedTimer = setTimeout(() => { shareCopied = false; }, 2000);
                  }}
                  title="Copy link"
                >
                  <Copy class="w-3 h-3" />
                </button>
                <button
                  type="button"
                  class="p-1 rounded-sm text-text-tertiary hover:text-error-soft hover:bg-bg-hover transition-colors opacity-0 group-hover:opacity-100"
                  onclick={() => { void removeSessionPermission(perm.resourceId); }}
                  title="Remove access"
                >
                  <X class="w-3 h-3" />
                </button>
              </div>
            </div>
          {:else}
            <div class="px-2 py-1 text-[12px] text-text-tertiary italic">No shared sessions</div>
          {/each}
        </div>

        {#if sessionPermError}
          <div class="px-2 py-1 text-[12px] text-error-soft break-all">{sessionPermError}</div>
        {/if}

        <div class="w-full h-px bg-border-subtle"></div>

      </section>

      {#if isOwner}
      <section class="space-y-3">
        <div class="text-[10px] font-bold text-text-tertiary uppercase tracking-widest flex items-center justify-between">
          <span>Collaborators</span>
          <span class="px-1.5 py-0.5 rounded-sm bg-bg-hover-strong text-text-secondary">{spaceCollaborators.length}</span>
        </div>

        <div class="space-y-2">
          <div class="flex gap-2">
            <input type="text" bind:value={addingCollaboratorUuid} placeholder="Paste user UUID" class="flex-1 px-2.5 py-[5px] rounded-[5px] bg-bg-input border border-border-subtle text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAddCollaborator(); } }} />
            <select bind:value={addingCollaboratorLevel} class="px-2 py-[5px] rounded-[5px] bg-bg-input border border-border-subtle text-[12px] text-text-secondary focus:border-brand/40 focus:outline-none">
              <option value="write">Write</option>
              <option value="read">Read</option>
            </select>
            <button type="button" onclick={() => { void handleAddCollaborator(); }} disabled={savingCollaborator || !addingCollaboratorUuid.trim()} class="px-2.5 py-[5px] rounded-[5px] bg-[#FF3E00] hover:bg-brand-hover text-[12px] text-white font-medium transition-colors disabled:opacity-50 cursor-pointer">{savingCollaborator ? '...' : 'Add'}</button>
          </div>
          {#if addingCollaboratorError}
            <div class="text-[11px] text-error-soft break-all">{addingCollaboratorError}</div>
          {/if}
        </div>

        {#if loadingCollaborators}
          <div class="flex items-center justify-center py-4 text-[12px] text-text-tertiary"><div class="w-3.5 h-3.5 rounded-full border-2 border-border-subtle border-t-brand animate-spin mr-2"></div>Loading...</div>
        {:else if spaceCollaborators.length === 0}
          <div class="px-2 py-1 text-[12px] text-text-tertiary italic">No collaborators</div>
        {:else}
          <div class="space-y-1">
            {#each spaceCollaborators as collab (collab.granteeUuid)}
              <div class="flex items-center gap-2 px-2 py-1.5 rounded-[4px] group hover:bg-bg-hover transition-colors">
                {#if collab.level === 'write'}<Pencil class="w-3.5 h-3.5 text-brand shrink-0" />{:else}<Eye class="w-3.5 h-3.5 text-text-tertiary shrink-0" />{/if}
                <code class="flex-1 text-[11px] font-mono text-text-secondary truncate select-all">{collab.granteeUuid}</code>
                <select value={collab.level} onchange={(event) => { void handleUpdateCollaboratorLevel(collab.granteeUuid!, (event.currentTarget as HTMLSelectElement).value as "read" | "write"); }} class="px-1.5 py-0.5 rounded-sm bg-bg-input border border-border-subtle text-[11px] text-text-secondary focus:border-brand/40 focus:outline-none">
                  <option value="write">Write</option>
                  <option value="read">Read</option>
                </select>
                <button type="button" class="p-1 rounded-sm text-text-tertiary hover:text-error-soft hover:bg-bg-hover transition-colors opacity-0 group-hover:opacity-100 cursor-pointer" onclick={() => { void handleRemoveCollaborator(collab.granteeUuid!); }} title="Remove collaborator"><X class="w-3 h-3" /></button>
              </div>
            {/each}
          </div>
        {/if}

        <div class="w-full h-px bg-border-subtle"></div>
      </section>
      {/if}

      <section class="space-y-3">
        <div class="text-[10px] font-bold text-text-tertiary uppercase tracking-widest flex items-center justify-between">
          <span>Channels</span>
          <span class="px-1.5 py-0.5 rounded-sm bg-bg-hover-strong text-text-secondary">{spaceChannels.length}</span>
        </div>

        {#if spaceChannels.length === 0}
          <div class="rounded-md border border-border-subtle bg-bg-hover p-3 text-[13px] text-text-tertiary">No channels bound.</div>
        {:else}
          <div class="space-y-3">
            {#each spaceChannels as spaceChannel (spaceChannel.id)}
              <div class="border border-border-subtle rounded-[5px] bg-bg-surface overflow-hidden">
                <div class="px-3 py-2 border-b border-border-subtle bg-bg-header-alt flex items-center gap-2">
                  <Hash class="w-3 h-3 text-text-tertiary" />
                  <span class="text-[12px] font-medium text-text-primary truncate">{spaceChannel.channel?.name || spaceChannel.channel?.provider}</span>
                </div>
                <div class="p-3">
                  {#if spaceChannel.channel?.provider === "discord"}
                    {@const config = getDiscordSpaceChannelConfig(spaceChannel)}
                    <div class="space-y-4">
                      <label class="flex items-start gap-2 cursor-pointer group">
                        <input type="checkbox" checked={config.inbound?.requireMentionInGuild !== false} onchange={(event) => patchDiscordSpaceChannelConfig(spaceChannel, (current) => ({ ...current, inbound: { ...(current.inbound ?? {}), requireMentionInGuild: (event.currentTarget as HTMLInputElement).checked } }))} class="mt-0.5 rounded-sm bg-bg-input border-border-subtle checked:bg-brand" />
                        <div class="flex flex-col min-w-0"><span class="text-[13px] text-text-secondary group-hover:text-text-primary transition-colors">Require mention in Guild</span><span class="text-[11px] text-text-placeholder">Respond only when mentioned</span></div>
                      </label>
                      <div class="w-full h-px bg-border-subtle"></div>
                      <label class="flex items-start gap-2 cursor-pointer group"><input type="checkbox" checked={config.outbound?.showThinking === true} onchange={(event) => patchDiscordSpaceChannelConfig(spaceChannel, (current) => ({ ...current, outbound: { ...(current.outbound ?? {}), showThinking: (event.currentTarget as HTMLInputElement).checked } }))} class="mt-0.5 rounded-sm bg-bg-input border-border-subtle checked:bg-brand" /><div class="flex flex-col"><span class="text-[13px] text-text-secondary group-hover:text-text-primary transition-colors">Show thinking</span></div></label>
                      <label class="flex items-start gap-2 cursor-pointer group"><input type="checkbox" checked={config.outbound?.showToolCalls === true} onchange={(event) => patchDiscordSpaceChannelConfig(spaceChannel, (current) => ({ ...current, outbound: { ...(current.outbound ?? {}), showToolCalls: (event.currentTarget as HTMLInputElement).checked } }))} class="mt-0.5 rounded-sm bg-bg-input border-border-subtle checked:bg-brand" /><div class="flex flex-col"><span class="text-[13px] text-text-secondary group-hover:text-text-primary transition-colors">Show tool calls</span></div></label>
                    </div>
                  {:else}
                    <div class="text-[13px] text-text-tertiary">No configuration available.</div>
                  {/if}
                  {#if savingChannelConfigById[spaceChannel.id]}<div class="mt-3 text-[10px] text-success-soft">Saving changes...</div>{/if}
                  {#if channelConfigErrorById[spaceChannel.id]}<div class="mt-3 text-[10px] text-error-soft break-all">{channelConfigErrorById[spaceChannel.id]}</div>{/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  </SettingsOverlay>

  {#if showShareModal && shareModalSessionId}
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" class="absolute inset-0 bg-black/40" aria-label="Close share dialog" onclick={() => { showShareModal = false; }}></button>
      <div class="relative w-full max-w-[380px] rounded-xl border border-border-subtle bg-bg-primary shadow-2xl overflow-hidden">
        <div class="h-9 flex items-center justify-between px-3 border-b border-border-subtle text-[10px] font-medium uppercase tracking-wider text-text-tertiary select-none">
          <span>{hasSessionPermission(shareModalSessionId!) ? 'Session is public' : 'Share session'}</span>
          <button type="button" class="flex items-center justify-center w-6 h-6 rounded-[4px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors" onclick={() => { showShareModal = false; }}><X class="w-3.5 h-3.5" /></button>
        </div>
        <div class="p-4 space-y-4">
          {#if hasSessionPermission(shareModalSessionId!)}
            <p class="text-[13px] text-text-secondary leading-relaxed">Anyone with the link can view this session. Choose how to manage access:</p>
            <div class="space-y-2">
              <button type="button" class="w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-[6px] border border-border-subtle bg-bg-surface hover:bg-bg-hover transition-colors disabled:opacity-50" onclick={() => { void removeSessionPermission(shareModalSessionId!).then((ok) => { if (ok) showShareModal = false; }); }} disabled={shareModalSaving}><Globe class="w-4 h-4 text-text-tertiary shrink-0 mt-0.5" /><div class="min-w-0"><div class="text-[13px] text-text-primary font-medium">Remove permission</div><div class="text-[11px] text-text-placeholder mt-0.5 leading-relaxed">Delete this session's access rule. It will inherit the space-level setting instead.</div></div></button>
              <button type="button" class="w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-[6px] border border-border-subtle bg-bg-surface hover:bg-bg-hover transition-colors disabled:opacity-50" onclick={() => { void makeSessionPrivate(); }} disabled={shareModalSaving}><Lock class="w-4 h-4 text-text-tertiary shrink-0 mt-0.5" /><div class="min-w-0"><div class="text-[13px] text-text-primary font-medium">Make private</div><div class="text-[11px] text-text-placeholder mt-0.5 leading-relaxed">Block all external access regardless of the space visibility setting.</div></div></button>
            </div>
            <button type="button" class="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-[5px] text-[13px] text-text-secondary hover:text-text-primary border border-border-subtle hover:bg-bg-hover transition-colors disabled:opacity-50" onclick={() => { const url = `${window.location.origin}/spaces/${spaceId}?session=${shareModalSessionId}`; void navigator.clipboard.writeText(url); shareCopied = true; if (shareCopiedTimer) clearTimeout(shareCopiedTimer); shareCopiedTimer = setTimeout(() => { shareCopied = false; }, 2000); }} disabled={shareModalSaving}>{#if shareCopied}<Check class="w-3.5 h-3.5 text-status-success" />Copied{:else}<Copy class="w-3.5 h-3.5" />Copy link{/if}</button>
          {:else}
            <p class="text-[13px] text-text-secondary leading-relaxed">This session will become publicly accessible. Anyone with the link can view the conversation.</p>
            <button type="button" class="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-[5px] bg-bg-primary hover:bg-bg-hover-strong border border-border-subtle text-[13px] text-text-primary font-medium transition-colors disabled:opacity-50" onclick={() => { void shareAndCopyLink(); }} disabled={shareModalSaving}>{#if shareModalSaving}<Loader2 class="w-3.5 h-3.5 animate-spin" />Sharing…{:else}<Share2 class="w-3.5 h-3.5" />Share &amp; copy link{/if}</button>
          {/if}
          {#if shareModalError}<div class="text-[12px] text-error-soft break-all">{shareModalError}</div>{/if}
        </div>
      </div>
    </div>
  {/if}

  <ModelSelector open={showModelSelector} onClose={() => { showModelSelector = false; }} onSelect={handleModelSelect} models={modelsCatalog ?? []} currentModel={activeSessionModel} />

  <MobileRightDrawer dragOffsetPx={rightDrawerDragOffsetPx} isDragging={rightDrawerIsDragging} isDrawerVisible={rightDrawerIsVisible}>
    <SpaceFileSidebar nodes={fileTree} selectedPath={urlFilePath ?? ""} loading={fileTreeLoading} error={fileTreeError} onToggle={handleFileToggle} onSelect={handleFileSelect} onRefresh={refreshFileTree} onCreateFile={handleCreateFile} onCreateDir={handleCreateDir} onRename={handleRenameNode} onDelete={handleDeleteNode} canWrite={canWrite} />
  </MobileRightDrawer>
</div>
</div>
<style>
  .right-sidebar-resize-handle {
    position: absolute;
    top: 0;
    left: -4px;
    bottom: 0;
    width: 8px;
    border: none;
    padding: 0;
    cursor: col-resize;
    background: transparent;
    touch-action: none;
    z-index: 10;
  }

  :global(body.sidebar-resizing) {
    cursor: col-resize;
    user-select: none;
  }

  /* No-write-permission hint toast */
  .hint-toast {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 50;
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--bg-primary, #1a1a2e);
    border: 1px solid var(--border-subtle, rgba(255,255,255,0.1));
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    font-size: 12px;
    color: var(--text-secondary, #b0b0c0);
    white-space: nowrap;
    animation: hint-fade-in 0.2s ease-out;
    pointer-events: none;
  }

  @keyframes hint-fade-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
