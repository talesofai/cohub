<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import {
	CornerDownRight,
	FolderKanban,
	Loader2,
	MessageSquare,
	Pin,
	Plus,
	Search,
	Tag,
	TerminalSquare,
	X,
} from "lucide-svelte";
import { onMount, tick } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import {
	resolveLocalCommandItems,
	withLocalCommands,
} from "$lib/command-palette/commands";
import { getCommandPaletteDefaultItems } from "$lib/command-palette/default-items";
import { searchLocalCommandItems } from "$lib/command-palette/local-search";
import { mergeCommandResults } from "$lib/command-palette/merge-results";
import { parseCommandPaletteQuery } from "$lib/command-palette/query";
import {
	getRecentCommandItems,
	openCommandItem,
	rememberCommandItem,
} from "$lib/command-palette/recent";
import { searchRemoteCommandItems } from "$lib/command-palette/remote-search";
import {
	getRemoteResourceTypes,
	typeLabelFor,
} from "$lib/command-palette/scope";
import {
	type IndexedPaletteItem,
	SPACE_ID_MIME,
	sectionMineSpaceItems,
} from "$lib/command-palette/space-groups";
import type { CommandPaletteItem } from "$lib/command-palette/types";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import SpacePickerMineGroups from "$lib/components/SpacePickerMineGroups.svelte";
import ToolCallList from "$lib/components/ToolCallList.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { sdk } from "$lib/sdk";
import { buildUserNewSessionRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import {
	getCollapsedSpaceGroupIds,
	setCollapsedSpaceGroupIds,
} from "$lib/stores/space-group-collapse";
import {
	addSpaceToGroup,
	createSpaceGroup,
	deleteSpaceGroup,
	fetchSpaceGroupsWithCache,
	getCachedSpaceGroups,
	onSpaceGroupsCacheUpdated,
	removeSpaceFromGroup,
} from "$lib/stores/space-groups.svelte";
import {
	fetchSpaceListWithCache,
	getCachedSpaceListMeta,
	onSpaceListCacheUpdated,
} from "$lib/stores/space-list-cache";
import {
	getCachedSpaceFilterPref,
	type SpaceFilterPref,
	setCachedSpaceFilterPref,
} from "$lib/stores/space-picker-filter";
import { toggleSpacePin } from "$lib/stores/space-pins.svelte";

/** Immediately reflect pin state on rendered items after a toggle. */
function syncPinStateInItems(spaceId: string, isPinned: boolean) {
	const patch = (items: CommandPaletteItem[]) =>
		items.map((item) =>
			item.type === "space" && item.spaceId === spaceId
				? { ...item, isPinned }
				: item,
		);
	defaultItems = patch(defaultItems);
	localItems = patch(localItems);
}

const MIN_QUERY_LENGTH = 2;
const RESULT_LIMIT = 30;
const DEBOUNCE_MS = 180;
const POINTER_HOVER_ARM_MS = 220;
const SPACE_LIST_REFRESH_MIN_INTERVAL_MS = 15_000;
const DEFAULT_PLACEHOLDER =
	"Search turns, sessions, spaces, labels… Try label:bug";

type CommandPaletteIntent = "navigate" | "new-chat";

type OpenCommandPaletteDetail = {
	query?: string;
	placeholder?: string;
	title?: string;
	refreshSpaces?: boolean;
	/** Controls where space items navigate. Default: open space landing. */
	intent?: CommandPaletteIntent;
};

let open = $state(false);
let query = $state("");
let title = $state("Command search");
let placeholder = $state(DEFAULT_PLACEHOLDER);
let openIntent = $state<CommandPaletteIntent>("navigate");
let inputEl = $state<HTMLInputElement | null>(null);
let resultsEl = $state<HTMLDivElement | null>(null);
let activeIndex = $state(0);
let settledItems = $state<CommandPaletteItem[]>([]);
let suppressPointerHover = $state(false);
let pointerHoverTimer: number | null = null;
let localItems = $state<CommandPaletteItem[]>([]);
let remoteItems = $state<import("@neta-art/cohub").GlobalSearchResult[]>([]);
let defaultItems = $state<CommandPaletteItem[]>([]);
let localDone = $state(true);
let remoteDone = $state(true);
let defaultDone = $state(true);
let refreshingSpaces = $state(false);
let remoteError = $state<string | null>(null);
let debounceTimer: number | null = null;
let localController: AbortController | null = null;
let remoteController: AbortController | null = null;
let searchToken = 0;
let spaceListRefreshToken = 0;
let activeSpaceListRefreshId = 0;
let forceSpaceRefreshForNextSearch = false;
let lastForcedSpaceListRefreshAt = 0;
let runMode = $state(false);
let runCommand = $state("");
let runTaskId = $state<string | null>(null);
let runProgress = $state<ContentBlock[] | null>(null);
let runResult = $state<ContentBlock[] | null>(null);
let runStatus = $state<"idle" | "queued" | "running" | "done" | "failed">(
	"idle",
);
let runError = $state("");
let runPollTimer: number | null = null;

// Space picker filter (All / Mine / Pinned) — shown when the palette operates
// in space-selection mode (query starts with `a:` or intent is new-chat).
type SpaceFilter = SpaceFilterPref;
let spaceFilter = $state<SpaceFilter>("all");
let spaceGroups = $state(getCachedSpaceGroups() ?? []);
let collapsedGroupIds = $state(getCollapsedSpaceGroupIds());
let dropTargetGroupId = $state<string | null>(null);
let creatingGroup = $state(false);
let createGroupName = $state("");
let createGroupError = $state<string | null>(null);

// Pagination for Space Picker mode: load larger page sizes (e.g. 50 items per page)
// and dynamically render more as user scrolls.
const SPACE_PAGE_SIZE = 50;
let spaceDisplayLimit = $state(SPACE_PAGE_SIZE);

function handleResultsScroll(event: Event) {
	if (!isSpacePickerMode || runMode) return;
	const target = event.currentTarget as HTMLElement | null;
	if (!target) return;
	// When scrolled within 100px of bottom, reveal next page
	if (target.scrollTop + target.clientHeight >= target.scrollHeight - 100) {
		const totalAvailable = filteredSpaceItems
			? filteredSpaceItems(mergedItemsRaw).length
			: mergedItemsRaw.length;
		if (spaceDisplayLimit < totalAvailable) {
			spaceDisplayLimit += SPACE_PAGE_SIZE;
		}
	}
}

// Space filter reset on change
$effect(() => {
	spaceFilter;
	query;
	open;
	spaceDisplayLimit = SPACE_PAGE_SIZE;
});

const currentSpaceId = $derived.by(() => {
	const match = page.url.pathname.match(/^\/spaces\/([^/]+)/);
	const id = match?.[1] ?? null;
	return id === "new" ? null : id;
});
const parsedQuery = $derived(parseCommandPaletteQuery(query));
const searchPlan = $derived({
	query: parsedQuery.query,
	resourceTypes: parsedQuery.resourceTypes,
	labelRef: parsedQuery.labelRef,
});
const trimmedQuery = $derived(searchPlan.query.trim());
const hasLabelScope = $derived(
	Boolean(searchPlan.labelRef && searchPlan.resourceTypes?.includes("label")),
);
const typeLabel = $derived(typeLabelFor(searchPlan.resourceTypes));
const isSpacePickerMode = $derived(
	openIntent === "new-chat" ||
		(searchPlan.resourceTypes?.length === 1 &&
			searchPlan.resourceTypes[0] === "space"),
);
const recentItems = $derived.by(() => {
	const items = getRecentCommandItems();
	if (!searchPlan.resourceTypes) return items;
	return items.filter((item) => searchPlan.resourceTypes?.includes(item.type));
});
// Local commands are always resolved synchronously — never blocked by network/IDB.
const localCommands = $derived(resolveLocalCommandItems(searchPlan));
const myUserUuid = $derived(authStore.userUuid);
const filteredSpaceItems = $derived.by(() => {
	if (!isSpacePickerMode || spaceFilter === "all") return null;
	return (items: CommandPaletteItem[]) =>
		items.filter((item) => {
			if (item.type !== "space") return true;
			if (spaceFilter === "mine")
				return item.ownerProfile?.userUuid === myUserUuid;
			if (spaceFilter === "pinned") return item.isPinned ?? false;
			return true;
		});
});
const mergedItemsRaw = $derived.by(() => {
	let raw =
		trimmedQuery.length < MIN_QUERY_LENGTH && !hasLabelScope
			? withLocalCommands(
					defaultItems.length > 0 ? defaultItems : recentItems,
					localCommands,
					RESULT_LIMIT,
				)
			: withLocalCommands(
					mergeCommandResults({
						local: localItems,
						remote: remoteItems,
						limit: RESULT_LIMIT * 2,
					}),
					localCommands,
					RESULT_LIMIT,
				);
	// New-chat intent is space-only: keep spaces + New Space, drop the rest.
	if (openIntent === "new-chat") {
		raw = raw.filter(
			(item) =>
				item.type === "space" ||
				(item.type === "command" && item.id === "new-space"),
		);
	}
	// Apply Mine / Pinned filter in space picker mode
	if (filteredSpaceItems) raw = filteredSpaceItems(raw);
	return raw;
});
const mergedItems = $derived.by(() => {
	if (isSpacePickerMode) {
		return mergedItemsRaw.slice(0, spaceDisplayLimit);
	}
	return mergedItemsRaw;
});
const isSearching = $derived(!localDone || !remoteDone || !defaultDone);
const baseRenderedItems = $derived(
	mergedItems.length > 0 || !isSearching ? mergedItems : settledItems,
);
const mineView = $derived.by(() => {
	if (!isSpacePickerMode || spaceFilter !== "mine" || runMode) return null;
	return sectionMineSpaceItems({
		items: baseRenderedItems,
		groups: spaceGroups,
		ownerUuid: myUserUuid,
		query: trimmedQuery.length >= MIN_QUERY_LENGTH ? trimmedQuery : "",
		collapsedGroupIds,
	});
});
const renderedItems = $derived(mineView?.rows ?? baseRenderedItems);
const showingMineGroups = $derived(Boolean(mineView));
const showingSettledItems = $derived(
	isSearching && mergedItems.length === 0 && settledItems.length > 0,
);
const showingSpaceRefreshStatus = $derived(
	refreshingSpaces &&
		Boolean(searchPlan.resourceTypes?.includes("space")) &&
		trimmedQuery.length < MIN_QUERY_LENGTH &&
		!hasLabelScope,
);
const runBlocks = $derived(runResult ?? runProgress ?? []);
const statusText = $derived.by(() => {
	const label = typeLabel ?? "Turns, Sessions, Spaces, Labels, and Commands";
	if (trimmedQuery.length < MIN_QUERY_LENGTH && !hasLabelScope) {
		if (showingSpaceRefreshStatus) return `${label} · syncing spaces…`;
		return renderedItems.length > 0
			? `${label} · type to filter`
			: `Search ${label.toLowerCase()}`;
	}
	if (showingSettledItems) return `${label} · searching…`;
	if (remoteError) return `${label} · local results only · ${remoteError}`;
	if (!remoteDone)
		return `${label} · local ${localItems.length + localCommands.length} · syncing server…`;
	if (!localDone) return `${label} · searching indexed cache…`;
	return `${label} · ${renderedItems.length} result${renderedItems.length === 1 ? "" : "s"} · indexed cache + server`;
});

function profileFor(item: CommandPaletteItem) {
	if (item.type !== "space") return null;
	return item.ownerProfile?.userUuid && item.ownerProfile.displayName
		? item.ownerProfile
		: null;
}

function resetGroupEditor() {
	creatingGroup = false;
	createGroupName = "";
	createGroupError = null;
	dropTargetGroupId = null;
}

function toggleGroupCollapsed(groupId: string) {
	const next = new Set(collapsedGroupIds);
	if (next.has(groupId)) next.delete(groupId);
	else next.add(groupId);
	collapsedGroupIds = next;
	setCollapsedSpaceGroupIds(next);
}

async function handleCreateGroup() {
	const name = createGroupName.trim();
	if (!name) return;
	createGroupError = null;
	try {
		await createSpaceGroup(name);
		spaceGroups = getCachedSpaceGroups() ?? spaceGroups;
		resetGroupEditor();
	} catch (error) {
		const body =
			error && typeof error === "object" && "body" in error
				? (error as { body?: { message?: unknown } }).body
				: null;
		createGroupError =
			typeof body?.message === "string"
				? body.message
				: error instanceof Error
					? error.message
					: "Could not create group";
	}
}

async function handleDeleteGroup(name: string) {
	try {
		await deleteSpaceGroup(name);
		spaceGroups = getCachedSpaceGroups() ?? spaceGroups;
	} catch (error) {
		console.warn("[palette] delete group failed", error);
	}
}

async function handleDropSpaceOnGroup(groupId: string, spaceId: string) {
	const group = spaceGroups.find((item) => item.id === groupId);
	if (!group || group.spaceIds.includes(spaceId)) return;
	try {
		await addSpaceToGroup(spaceId, group.name);
		spaceGroups = getCachedSpaceGroups() ?? spaceGroups;
	} catch (error) {
		console.warn("[palette] add to group failed", error);
	}
}

async function handleRemoveSpaceFromGroup(spaceId: string, groupId: string) {
	const group = spaceGroups.find((item) => item.id === groupId);
	if (!group) return;
	try {
		await removeSpaceFromGroup(spaceId, group.name);
		spaceGroups = getCachedSpaceGroups() ?? spaceGroups;
	} catch (error) {
		console.warn("[palette] remove from group failed", error);
	}
}

function handleSpaceDragStart(event: DragEvent, spaceId: string) {
	if (!event.dataTransfer) return;
	event.dataTransfer.setData(SPACE_ID_MIME, spaceId);
	event.dataTransfer.setData("text/plain", spaceId);
	event.dataTransfer.effectAllowed = "copy";
}

function armPointerHover() {
	suppressPointerHover = true;
	if (pointerHoverTimer != null) window.clearTimeout(pointerHoverTimer);
	pointerHoverTimer = window.setTimeout(() => {
		suppressPointerHover = false;
		pointerHoverTimer = null;
	}, POINTER_HOVER_ARM_MS);
}

function handleResultPointerMove(index: number) {
	if (suppressPointerHover) return;
	activeIndex = index;
}

function remoteSearchSpaceId(
	spaceId: string | null,
	remoteResourceTypes: ReturnType<typeof getRemoteResourceTypes>,
) {
	if (!spaceId) return undefined;
	if (!remoteResourceTypes || remoteResourceTypes.includes("space"))
		return undefined;
	return spaceId;
}

function handleCommandInput(event: Event) {
	const value = (event.currentTarget as HTMLInputElement).value;
	if (runMode) {
		runCommand = value;
		if (runStatus !== "running" && runStatus !== "queued") {
			runTaskId = null;
			runProgress = null;
			runResult = null;
			runError = "";
			runStatus = "idle";
		}
		return;
	}
	query = value;
}

function typeMeta(type: CommandPaletteItem["type"]) {
	if (type === "turn") return { className: "turn", icon: MessageSquare };
	if (type === "session") return { className: "session", icon: TerminalSquare };
	if (type === "label") return { className: "label", icon: Tag };
	if (type === "command") return { className: "command", icon: Plus };
	return { className: "space", icon: FolderKanban };
}

function contextFor(item: CommandPaletteItem) {
	if (item.type === "command") return item.excerpt ?? "Command";
	if (item.type === "space") return item.excerpt ?? "Space";
	if (item.type === "label")
		return `Label: ${item.labelRef ?? item.labelName ?? "Label"}${item.spaceName ? ` · ${item.spaceName}` : ""}`;
	if (item.type === "session") return item.spaceName ?? "Session";
	return `${item.spaceName ?? "Space"}${item.sessionTitle ? ` / ${item.sessionTitle}` : ""} · Turn #${item.sequence ?? "?"}`;
}

function itemTimestamp(item: CommandPaletteItem) {
	if (!item.updatedAt) return null;
	const date = new Date(item.updatedAt);
	const time = date.getTime();
	if (!Number.isFinite(time)) return null;

	const now = new Date();
	const isSameLocalDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	const pad = (value: number) => String(value).padStart(2, "0");
	const dateLabel = `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
	const timeLabel = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const timezoneLabel = new Intl.DateTimeFormat(undefined, {
		timeZoneName: "short",
	})
		.formatToParts(date)
		.find((part) => part.type === "timeZoneName")?.value;

	return {
		label: isSameLocalDay ? timeLabel : dateLabel,
		title: `${dateLabel} ${timeLabel}${timezoneLabel ? ` ${timezoneLabel}` : ""}`,
	};
}

function resetRunState() {
	runMode = false;
	runCommand = "";
	runTaskId = null;
	runProgress = null;
	runResult = null;
	runStatus = "idle";
	runError = "";
	if (runPollTimer != null) window.clearInterval(runPollTimer);
	runPollTimer = null;
}

function openPalette(detail?: OpenCommandPaletteDetail) {
	title = detail?.title ?? "Command search";
	placeholder = detail?.placeholder ?? DEFAULT_PLACEHOLDER;
	query = detail?.query ?? "";
	openIntent = detail?.intent ?? "navigate";
	spaceFilter = getCachedSpaceFilterPref();
	spaceGroups = getCachedSpaceGroups() ?? spaceGroups;
	collapsedGroupIds = getCollapsedSpaceGroupIds();
	resetGroupEditor();
	forceSpaceRefreshForNextSearch = Boolean(detail?.refreshSpaces);
	activeIndex = 0;
	armPointerHover();
	resetRunState();
	open = true;
	void tick().then(() => inputEl?.focus());
}

function closePalette() {
	open = false;
	query = "";
	title = "Command search";
	placeholder = DEFAULT_PLACEHOLDER;
	openIntent = "navigate";
	spaceFilter = getCachedSpaceFilterPref();
	resetGroupEditor();
	activeIndex = 0;
	settledItems = [];
	refreshingSpaces = false;
	searchToken += 1;
	localController?.abort();
	remoteController?.abort();
	resetRunState();
}

function resetSearch(options?: { clearDefaultItems?: boolean }) {
	localController?.abort();
	remoteController?.abort();
	if (debounceTimer != null) window.clearTimeout(debounceTimer);
	localItems = [];
	remoteItems = [];
	if (options?.clearDefaultItems !== false) defaultItems = [];
	localDone = true;
	remoteDone = true;
	defaultDone = true;
	remoteError = null;
	activeIndex = 0;
}

async function refreshSpaceListForDefaultItems(
	token: number,
	options?: { force?: boolean },
) {
	let force = Boolean(options?.force);
	if (force) {
		const now = Date.now();
		if (
			now - lastForcedSpaceListRefreshAt <
			SPACE_LIST_REFRESH_MIN_INTERVAL_MS
		) {
			force = false;
		} else {
			lastForcedSpaceListRefreshAt = now;
		}
	}

	if (!force) {
		const cacheMeta = getCachedSpaceListMeta();
		if (cacheMeta && !cacheMeta.isStale) return;
	}

	try {
		const refreshId = ++activeSpaceListRefreshId;
		refreshingSpaces = true;
		try {
			await fetchSpaceListWithCache(async () => await sdk.spaces.list(), {
				force,
			});
		} finally {
			if (activeSpaceListRefreshId === refreshId) refreshingSpaces = false;
		}
	} catch (error) {
		console.warn("[command-palette] space list refresh failed", error);
		return;
	}

	if (token !== searchToken || !open || runMode) return;
	if (trimmedQuery.length >= MIN_QUERY_LENGTH) return;
	spaceListRefreshToken += 1;
}

function scheduleSearch(plan: typeof searchPlan, spaceId: string | null) {
	const q = plan.query.trim();
	const isLabelScope = Boolean(
		plan.labelRef && plan.resourceTypes?.includes("label"),
	);
	const token = ++searchToken;
	const forceSpaceRefresh = forceSpaceRefreshForNextSearch;
	forceSpaceRefreshForNextSearch = false;
	if (q.length < MIN_QUERY_LENGTH && !isLabelScope) {
		// Keep previous default/resource items while reloading so the list does not
		// flash empty. Local commands stay visible via withLocalCommands either way.
		resetSearch({ clearDefaultItems: false });
		defaultDone = false;
		localController = new AbortController();
		void refreshSpaceListForDefaultItems(token, { force: forceSpaceRefresh });
		void getCommandPaletteDefaultItems({
			...plan,
			currentSpaceId: spaceId,
			signal: localController.signal,
		})
			.then((items) => {
				if (token !== searchToken) return;
				defaultItems = items;
			})
			.catch((error) => {
				console.warn("[command-palette] default items failed", error);
			})
			.finally(() => {
				if (token === searchToken) defaultDone = true;
			});
		return;
	}

	resetSearch();
	localDone = false;
	remoteDone = false;
	localController = new AbortController();
	remoteController = new AbortController();

	void searchLocalCommandItems(q, {
		signal: localController.signal,
		resourceTypes: plan.resourceTypes,
		labelRef: plan.labelRef,
	})
		.then((items) => {
			if (token !== searchToken) return;
			localItems = items;
		})
		.catch((error) => {
			if (error?.name !== "AbortError")
				console.warn("[command-palette] local search failed", error);
		})
		.finally(() => {
			if (token === searchToken) localDone = true;
		});

	const remoteResourceTypes = getRemoteResourceTypes(plan);
	if (remoteResourceTypes && remoteResourceTypes.length === 0) {
		remoteDone = true;
		return;
	}

	debounceTimer = window.setTimeout(() => {
		void searchRemoteCommandItems(q, {
			signal: remoteController?.signal,
			limit: RESULT_LIMIT,
			types: remoteResourceTypes,
			spaceId: remoteSearchSpaceId(spaceId, remoteResourceTypes),
			labelRef: plan.labelRef,
		})
			.then((items) => {
				if (token !== searchToken) return;
				remoteItems = items;
				remoteError = null;
			})
			.catch((error) => {
				if (token !== searchToken || error?.name === "AbortError") return;
				remoteError =
					error instanceof Error ? error.message : "server unavailable";
			})
			.finally(() => {
				if (token === searchToken) remoteDone = true;
			});
	}, DEBOUNCE_MS);
}

function openRunCommandMode() {
	runMode = true;
	title = "Run Command";
	placeholder = "Type a command…";
	runCommand = "";
	runTaskId = null;
	runProgress = null;
	runResult = null;
	runStatus = "idle";
	runError = "";
	activeIndex = 0;
	void tick().then(() => inputEl?.focus());
}

async function submitRunCommand() {
	if (!currentSpaceId) {
		runError = "Open a space first.";
		runStatus = "failed";
		return;
	}
	if (!runCommand.trim() || runStatus === "running" || runStatus === "queued")
		return;
	runError = "";
	runStatus = "queued";
	try {
		const { taskRunId } = await sdk.space(currentSpaceId).runCommand({
			command: runCommand.trim(),
		});
		runTaskId = taskRunId;
		runProgress = null;
		runResult = null;
		runStatus = "running";
		if (runPollTimer != null) window.clearInterval(runPollTimer);
		const poll = async () => {
			if (!runTaskId) return;
			try {
				const { run, progress } = await sdk.tasks.get(runTaskId);
				runProgress =
					(progress as { content?: ContentBlock[] } | null)?.content ?? null;
				if (run.status === "completed") {
					runStatus = "done";
					runResult =
						(run.result as { content?: ContentBlock[] } | null)?.content ??
						null;
					if (runPollTimer != null) window.clearInterval(runPollTimer);
					runPollTimer = null;
					return;
				}
				if (run.status === "failed") {
					runStatus = "failed";
					runError = run.errorMessage ?? "Command failed";
					if (runPollTimer != null) window.clearInterval(runPollTimer);
					runPollTimer = null;
				}
			} catch (error) {
				console.warn("[command-palette] command polling failed", error);
			}
		};
		await poll();
		runPollTimer = window.setInterval(() => void poll(), 1000);
	} catch (error) {
		runStatus = "failed";
		runError = error instanceof Error ? error.message : "Failed to run command";
	}
}

async function activate(item: CommandPaletteItem | undefined) {
	if (!item) return;
	if (item.id === "run-command") {
		// Not meaningful while picking a space for new chat.
		if (openIntent === "new-chat") return;
		openRunCommandMode();
		return;
	}
	// New-chat intent: only space (or create-space) actions are valid.
	if (openIntent === "new-chat") {
		if (item.type === "space" && item.spaceId) {
			rememberCommandItem(item);
			closePalette();
			await goto(buildUserNewSessionRoute(item.spaceId), {
				keepFocus: true,
				noScroll: true,
			});
			return;
		}
		if (item.type === "command" && item.id === "new-space") {
			await openCommandItem(item);
			closePalette();
			return;
		}
		// Ignore sessions/labels/turns — keep palette open for a real space pick.
		return;
	}
	await openCommandItem(item);
	closePalette();
}

function moveActive(delta: number) {
	if (renderedItems.length === 0) {
		activeIndex = 0;
		return;
	}
	activeIndex = Math.min(
		Math.max(activeIndex + delta, 0),
		renderedItems.length - 1,
	);
}

async function scrollActiveIntoView() {
	if (!open) return;
	await tick();
	resultsEl
		?.querySelector<HTMLElement>(".command-result.active")
		?.scrollIntoView({ block: "nearest" });
}

function handlePaletteKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
		if (runMode) {
			if (runStatus === "running" || runStatus === "queued") {
				closePalette();
				return;
			}
			if (runCommand.trim()) {
				runMode = false;
				title = "Command search";
				placeholder = DEFAULT_PLACEHOLDER;
				runStatus = "idle";
				return;
			}
		}
		closePalette();
		return;
	}
	if (isComposingKeyboardEvent(event)) return;
	if (runMode) {
		if (event.key === "Enter") {
			event.preventDefault();
			void submitRunCommand();
		}
		return;
	}
	if (
		event.key === "ArrowDown" ||
		(event.ctrlKey && event.key.toLowerCase() === "n")
	) {
		event.preventDefault();
		moveActive(1);
		return;
	}
	if (
		event.key === "ArrowUp" ||
		(event.ctrlKey && event.key.toLowerCase() === "p")
	) {
		event.preventDefault();
		moveActive(-1);
		return;
	}
	if (event.key === "Enter") {
		event.preventDefault();
		void activate(renderedItems[activeIndex]);
	}
}

function handleGlobalKeydown(event: KeyboardEvent) {
	if (isComposingKeyboardEvent(event)) return;
	if (open && event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		closePalette();
		return;
	}

	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
		event.preventDefault();
		open ? closePalette() : openPalette();
	}
}

function handleOpenPaletteEvent(event: Event) {
	openPalette((event as CustomEvent<OpenCommandPaletteDetail>).detail);
}

$effect(() => {
	if (!open || runMode) return;
	spaceListRefreshToken;
	scheduleSearch(searchPlan, currentSpaceId);
});

$effect(() => {
	if (!open || !isSpacePickerMode || runMode) return;
	const cached = getCachedSpaceGroups();
	if (cached) spaceGroups = cached;
	void fetchSpaceGroupsWithCache()
		.then((groups) => {
			spaceGroups = groups;
		})
		.catch((error) => {
			console.warn("[command-palette] space groups refresh failed", error);
		});
});

$effect(() => {
	if (mergedItems.length > 0 || !isSearching) settledItems = mergedItems;
});

$effect(() => {
	if (activeIndex >= renderedItems.length)
		activeIndex = Math.max(renderedItems.length - 1, 0);
});

$effect(() => {
	activeIndex;
	renderedItems.length;
	void scrollActiveIntoView();
});

onMount(() => {
	window.addEventListener("keydown", handleGlobalKeydown, { capture: true });
	window.addEventListener("cohub:open-command-palette", handleOpenPaletteEvent);
	// Refresh space items when the space list cache changes (e.g. pin toggle)
	// so the palette reflects the new isPinned state immediately.
	const offSpaceListCache = onSpaceListCacheUpdated(() => {
		if (open && !runMode) spaceListRefreshToken += 1;
	});
	const offSpaceGroupsCache = onSpaceGroupsCacheUpdated(({ groups }) => {
		spaceGroups = groups;
	});
	return () => {
		window.removeEventListener("keydown", handleGlobalKeydown, {
			capture: true,
		});
		window.removeEventListener(
			"cohub:open-command-palette",
			handleOpenPaletteEvent,
		);
		offSpaceListCache();
		offSpaceGroupsCache();
		localController?.abort();
		remoteController?.abort();
		if (debounceTimer != null) window.clearTimeout(debounceTimer);
		if (pointerHoverTimer != null) window.clearTimeout(pointerHoverTimer);
	};
});
</script>

{#if open}
	<div class="command-palette-root" role="presentation" onmousedown={(event) => { if (event.target === event.currentTarget) closePalette(); }}>
		<div class="command-palette" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" onkeydown={handlePaletteKeydown}>
			<div class="command-input-row">
				{#if runMode}
					<TerminalSquare class="h-4 w-4 text-brand" />
				{:else}
					<Search class="h-4 w-4 text-text-tertiary" />
				{/if}
				<input
					bind:this={inputEl}
					value={runMode ? runCommand : query}
					class="command-input"
					placeholder={placeholder}
					autocomplete="off"
					spellcheck="false"
					oninput={handleCommandInput}
				/>
				{#if runMode}
					<div class="command-shortcut">↵ Run</div>
				{:else}
					<div class="command-shortcut">⌘K</div>
				{/if}
			</div>

			{#if isSpacePickerMode && !runMode}
				<div class="space-filter-bar" role="tablist" aria-label="Filter spaces">
					{#each [{ key: "all", label: "All" }, { key: "mine", label: "Mine" }, { key: "pinned", label: "Pinned" }] as filter}
						<button
							type="button"
							class="space-filter-btn"
							class:active={spaceFilter === filter.key}
							role="tab"
							aria-selected={spaceFilter === filter.key}
							onclick={() => { spaceFilter = filter.key as SpaceFilter; setCachedSpaceFilterPref(filter.key as SpaceFilter); activeIndex = 0; }}
						>{filter.label}</button>
					{/each}
				</div>
			{/if}

			{#if runMode}
				<div bind:this={resultsEl} class="command-results command-runner">
					{#if runError}
						<div class="command-empty">
							<div class="command-empty-mark"><CornerDownRight class="h-4 w-4" /></div>
							<div>
								<div class="text-[13px] font-medium text-text-secondary">{runStatus === "failed" ? "Command failed" : "Run command ready"}</div>
								<div class="mt-1 text-[12px] text-text-tertiary">{runError}</div>
							</div>
						</div>
					{:else if !currentSpaceId}
						<div class="command-empty">
							<div class="command-empty-mark"><CornerDownRight class="h-4 w-4" /></div>
							<div>
								<div class="text-[13px] font-medium text-text-secondary">Open a space first</div>
								<div class="mt-1 text-[12px] text-text-tertiary">Run commands need a space context.</div>
							</div>
						</div>
					{:else if runBlocks.length === 0}
						<div class="command-empty">
							<div class="command-empty-mark"><CornerDownRight class="h-4 w-4" /></div>
							<div>
								<div class="text-[13px] font-medium text-text-secondary">Ready to run</div>
								<div class="mt-1 text-[12px] text-text-tertiary">Enter a bash command and press ↵.</div>
							</div>
						</div>
					{:else}
						<ToolCallList content={runBlocks} streaming={runStatus === "running" || runStatus === "queued"} defaultExpanded flush />
					{/if}
				</div>
			{:else}
				<div bind:this={resultsEl} class:searching={showingSettledItems} class="command-results" role="listbox" aria-label="Search results" onscroll={handleResultsScroll}>
					{#snippet paletteRow(item: CommandPaletteItem, index: number, groupId: string | null)}
						{@const meta = typeMeta(item.type)}
						{@const Icon = meta.icon}
						{@const profile = profileFor(item)}
						{@const timestamp = itemTimestamp(item)}
						<div
							class:active={index === activeIndex}
							class="command-result"
							onpointermove={() => handleResultPointerMove(index)}
							role="option"
							aria-selected={index === activeIndex}
							tabindex="-1"
						>
							<button
								type="button"
								class="command-result-main"
								draggable={showingMineGroups && item.type === "space"}
								onclick={() => void activate(item)}
								ondragstart={(event) => {
									if (item.type !== "space") return;
									handleSpaceDragStart(event, item.spaceId);
								}}
							>
								{#if item.type === "space"}
									<SpaceAvatar name={item.title || item.spaceName || item.spaceId} profile={item.spaceProfile} size="sm" />
								{:else}
									<div class={`command-type-mark ${meta.className}`} aria-label={item.type}>
										<Icon class="h-3.5 w-3.5" />
									</div>
								{/if}
								<div class="min-w-0 flex-1 text-left">
									<div class="flex min-w-0 items-center gap-2">
										<span class="truncate text-[13px] font-medium text-text-primary">{item.title}</span>
									</div>
									<div class="command-context-row">
										{#if profile}
											<span class="command-profile" title={profile.displayName}>
												<UserAvatar name={profile.displayName} avatarUrl={profile.avatarUrl} size="xxs" class="border-0 bg-bg-primary text-[8px]" />
												<span class="truncate">{profile.displayName}</span>
											</span>
											<span class="command-context-separator">·</span>
										{/if}
										<span class="command-context" title={contextFor(item)}>{contextFor(item)}</span>
										{#if timestamp}
											<span class="command-context-separator">·</span>
											<time class="command-time" datetime={item.updatedAt ?? undefined} title={timestamp.title}>{timestamp.label}</time>
										{/if}
									</div>
								</div>
								<div class="command-enter">↵</div>
							</button>
							{#if showingMineGroups && groupId && item.type === "space"}
								<button
									type="button"
									class="command-pin-btn command-ungroup-btn"
									title={`Remove from group`}
									aria-label={`Remove ${item.title} from group`}
									onclick={(event) => {
										event.stopPropagation();
										void handleRemoveSpaceFromGroup(item.spaceId, groupId);
									}}
								>
									<X class="h-3.5 w-3.5" />
								</button>
							{/if}
							{#if isSpacePickerMode && item.type === "space"}
								<button
									type="button"
									class="command-pin-btn"
									class:pinned={item.isPinned}
									title={item.isPinned ? "Unpin" : "Pin"}
									aria-label={item.isPinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
									onclick={(e) => {
								e.stopPropagation();
								const wasPinned = item.isPinned ?? false;
								syncPinStateInItems(item.spaceId, !wasPinned);
								void toggleSpacePin(item.spaceId).catch((err) => {
									console.warn("[palette] pin toggle failed", err);
									syncPinStateInItems(item.spaceId, wasPinned);
								});
							}}
								>
									<Pin class="h-3.5 w-3.5" />
								</button>
							{/if}
						</div>
					{/snippet}
					{#snippet mineCommandRow(row: IndexedPaletteItem)}
						{@render paletteRow(row.item, row.index, null)}
					{/snippet}
					{#snippet mineSpaceRow(row: IndexedPaletteItem, groupId: string | null)}
						{@render paletteRow(row.item, row.index, groupId)}
					{/snippet}
					{#if renderedItems.length === 0 && !mineView?.sections.length}
						<div class="command-empty">
							<div class="command-empty-mark"><CornerDownRight class="h-4 w-4" /></div>
							<div>
								<div class="text-[13px] font-medium text-text-secondary">
									{#if isSpacePickerMode && spaceFilter === "pinned"}
										No pinned spaces
									{:else if isSpacePickerMode && spaceFilter === "mine"}
										No spaces you own
									{:else if trimmedQuery.length < MIN_QUERY_LENGTH && !hasLabelScope}
										Command lens ready
									{:else}
										No matching results
									{/if}
								</div>
								<div class="mt-1 text-[12px] text-text-tertiary">
									{#if isSpacePickerMode && spaceFilter === "pinned"}
										Pin a space to bookmark it here.
									{:else if isSpacePickerMode && spaceFilter === "mine"}
										Create a group to organize the Spaces you own.
									{:else if trimmedQuery.length < MIN_QUERY_LENGTH && !hasLabelScope}
										Try label:bug for labels, a: for spaces, or t: for turns.
									{:else}
										Try a different phrase or type filter.
									{/if}
								</div>
							</div>
						</div>
						{#if showingMineGroups}
							<SpacePickerMineGroups
								commands={[]}
								sections={[]}
								ungrouped={[]}
								{collapsedGroupIds}
								dropTargetId={dropTargetGroupId}
								creating={creatingGroup}
								createName={createGroupName}
								createError={createGroupError}
								commandRow={mineCommandRow}
								spaceRow={mineSpaceRow}
								onToggleCollapsed={toggleGroupCollapsed}
								onDeleteGroup={(name) => void handleDeleteGroup(name)}
								onDropSpace={(groupId, spaceId) => void handleDropSpaceOnGroup(groupId, spaceId)}
								onDragOverGroup={(groupId) => { dropTargetGroupId = groupId; }}
								onStartCreate={() => { creatingGroup = true; createGroupError = null; }}
								onCancelCreate={resetGroupEditor}
								onCreateNameInput={(value) => { createGroupName = value; }}
								onSubmitCreate={() => void handleCreateGroup()}
							/>
						{/if}
					{:else if showingMineGroups && mineView}
						<SpacePickerMineGroups
							commands={mineView.commands}
							sections={mineView.sections}
							ungrouped={mineView.ungrouped}
							{collapsedGroupIds}
							dropTargetId={dropTargetGroupId}
							creating={creatingGroup}
							createName={createGroupName}
							createError={createGroupError}
							commandRow={mineCommandRow}
							spaceRow={mineSpaceRow}
							onToggleCollapsed={toggleGroupCollapsed}
							onDeleteGroup={(name) => void handleDeleteGroup(name)}
							onDropSpace={(groupId, spaceId) => void handleDropSpaceOnGroup(groupId, spaceId)}
							onDragOverGroup={(groupId) => { dropTargetGroupId = groupId; }}
							onStartCreate={() => { creatingGroup = true; createGroupError = null; }}
							onCancelCreate={resetGroupEditor}
							onCreateNameInput={(value) => { createGroupName = value; }}
							onSubmitCreate={() => void handleCreateGroup()}
						/>
						{#if isSpacePickerMode && mergedItemsRaw.length > spaceDisplayLimit}
							<div class="flex items-center justify-center py-2 text-[11px] text-text-tertiary">
								<span>Showing {spaceDisplayLimit} of {mergedItemsRaw.length} spaces · scroll for more</span>
							</div>
						{/if}
					{:else}
						{#each renderedItems as item, index (`${item.type}:${item.id || item.turnId || item.sessionId || item.spaceId}`)}
							{@render paletteRow(item, index, null)}
						{/each}
						{#if isSpacePickerMode && mergedItemsRaw.length > spaceDisplayLimit}
							<div class="flex items-center justify-center py-2 text-[11px] text-text-tertiary">
								<span>Showing {spaceDisplayLimit} of {mergedItemsRaw.length} spaces · scroll for more</span>
							</div>
						{/if}
					{/if}
				</div>
			{/if}

			<div class="command-footer">
				<div class:error={Boolean(runError)} class="command-status" role="status" aria-live="polite">
					{#if runMode}
						{#if runStatus === "queued" || runStatus === "running"}<Loader2 class="h-3 w-3 animate-spin text-brand" />{/if}
						<span>{runError || (runStatus === "done" ? `Done · ${runTaskId}` : runStatus === "running" ? "Running…" : runStatus === "queued" ? "Queued…" : currentSpaceId ? "Press ↵ to run" : "Open a space first")}</span>
					{:else}
						{#if isSearching || showingSpaceRefreshStatus}<Loader2 class="h-3 w-3 animate-spin text-brand" />{/if}
						<span>{statusText}</span>
					{/if}
				</div>
				<div class="hidden items-center gap-2 sm:flex"><span>↑↓</span><span>C-n/p</span><span>navigate</span><span>↵</span><span>open</span><span>esc</span><span>close</span></div>
			</div>
		</div>
	</div>
{/if}

<style>
	.command-palette-root {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: clamp(48px, 10vh, 92px) 16px 24px;
		background: color-mix(in oklch, var(--bg-primary) 56%, transparent);
	}

	.command-palette {
		width: min(720px, calc(100vw - 32px));
		max-height: min(640px, calc(100vh - 96px));
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid color-mix(in oklch, var(--border-primary) 72%, var(--brand) 8%);
		border-radius: 14px;
		background: color-mix(in oklch, var(--bg-surface) 94%, var(--brand-900) 6%);
		box-shadow: 0 24px 80px color-mix(in oklch, var(--neutral-100) 74%, transparent), 0 0 0 1px color-mix(in oklch, var(--neutral-0) 4%, transparent) inset;
		animation: command-enter 140ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.command-input-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 16px;
		border-bottom: 1px solid var(--border-subtle);
		background: color-mix(in oklch, var(--bg-primary) 30%, transparent);
	}

	.command-input {
		min-width: 0;
		flex: 1;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--text-primary);
		font-size: 15px;
		line-height: 1.4;
	}

	.command-input::placeholder { color: var(--text-placeholder); }

	.command-shortcut,
	.command-enter,
	.command-footer {
		font-family: var(--font-mono);
		letter-spacing: 0.02em;
	}

	.command-shortcut {
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		padding: 2px 6px;
		color: var(--text-tertiary);
		font-size: 11px;
	}

	.command-results {
		overflow-y: auto;
		padding: 8px;
		transition: opacity 120ms cubic-bezier(0.25, 1, 0.5, 1);
	}

	.command-results.searching {
		opacity: 0.72;
	}

	.command-result {
		position: relative;
		display: flex;
		width: 100%;
		align-items: center;
		gap: 4px;
		border: 0;
		border-radius: 9px;
		background: transparent;
		padding: 6px 6px;
		color: inherit;
		transition: background-color 90ms cubic-bezier(0.25, 1, 0.5, 1), transform 90ms cubic-bezier(0.25, 1, 0.5, 1);
	}

	.command-result-main {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
		flex: 1;
		border: 0;
		background: transparent;
		color: inherit;
		padding: 4px 4px;
		border-radius: 7px;
		cursor: pointer;
	}

	.command-result-main:focus-visible {
		outline: 2px solid color-mix(in oklch, var(--brand) 42%, transparent);
		outline-offset: -2px;
	}

	.command-pin-btn {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-tertiary);
		opacity: 0;
		cursor: pointer;
		transition: opacity 90ms cubic-bezier(0.25, 1, 0.5, 1), background-color 90ms cubic-bezier(0.25, 1, 0.5, 1), color 90ms cubic-bezier(0.25, 1, 0.5, 1);
	}

	.command-pin-btn:focus-visible {
		opacity: 1;
		outline: 2px solid color-mix(in oklch, var(--brand) 42%, transparent);
		outline-offset: -2px;
	}

	.command-pin-btn.pinned {
		opacity: 1;
		color: var(--brand);
	}

	.command-ungroup-btn:hover {
		color: var(--error-700);
	}

	.command-pin-btn:hover {
		opacity: 1;
		background: var(--bg-hover);
		color: var(--brand);
	}

	.command-pin-btn:active {
		transform: scale(0.92);
	}

	.command-result.active .command-pin-btn { opacity: 1; }
	.command-result.active .command-pin-btn:not(.pinned) { color: var(--text-tertiary); }

	.command-result::before {
		content: "";
		position: absolute;
		left: 0;
		top: 8px;
		bottom: 8px;
		width: 2px;
		border-radius: 999px;
		background: transparent;
	}

	.command-result.active { background: color-mix(in oklch, var(--brand-bg) 56%, var(--bg-hover) 44%); }
	.command-result.active::before { background: var(--brand); }
	.command-result.active .command-enter {
		opacity: 1;
	}
	.command-result.active .command-time { color: var(--text-secondary); }
	.command-result.active .command-type-mark { border-color: color-mix(in oklch, currentColor 36%, transparent); }

	.command-type-mark {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border: 1px solid color-mix(in oklch, currentColor 18%, transparent);
		border-radius: 7px;
		background: color-mix(in oklch, currentColor 10%, var(--bg-primary) 90%);
		color: var(--text-tertiary);
	}

	.command-type-mark.space {
		color: var(--brand);
		background: color-mix(in oklch, var(--brand) 12%, var(--bg-primary) 88%);
	}

	.command-type-mark.session {
		color: color-mix(in oklch, var(--text-secondary) 82%, var(--brand) 18%);
		background: color-mix(in oklch, var(--text-secondary) 8%, var(--bg-primary) 92%);
	}

	.command-type-mark.turn {
		color: color-mix(in oklch, var(--text-tertiary) 72%, var(--brand) 28%);
		background: color-mix(in oklch, var(--text-tertiary) 7%, var(--bg-primary) 93%);
	}

	.command-type-mark.label {
		color: color-mix(in oklch, var(--brand) 76%, var(--text-secondary) 24%);
		background: color-mix(in oklch, var(--brand) 9%, var(--bg-primary) 91%);
	}

	.command-type-mark.command {
		color: var(--brand);
		background: color-mix(in oklch, var(--brand) 10%, var(--bg-primary) 90%);
	}

	.command-context-row {
		margin-top: 2px;
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 6px;
		color: var(--text-tertiary);
		font-size: 12px;
		line-height: 1.35;
	}

	.command-profile {
		display: inline-flex;
		min-width: 0;
		max-width: min(190px, 42%);
		flex-shrink: 0;
		align-items: center;
		gap: 5px;
		color: color-mix(in oklch, var(--text-secondary) 86%, var(--brand) 14%);
	}

	.command-context {
		min-width: 0;
		flex: 0 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.command-context-separator {
		flex: 0 0 auto;
		color: var(--text-placeholder);
	}

	.command-time {
		flex: 0 0 auto;
		color: var(--text-placeholder);
		font-family: var(--font-mono);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.01em;
		line-height: 1;
		white-space: nowrap;
	}

	.command-enter {
		width: 12px;
		flex: 0 0 auto;
		opacity: 0;
		color: var(--brand);
		font-size: 13px;
		line-height: 1;
		text-align: right;
	}

	.command-empty {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 34px 22px;
	}

	.command-empty-mark {
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border-radius: 9px;
		background: var(--bg-primary);
		color: var(--text-tertiary);
	}

	.command-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		border-top: 1px solid var(--border-subtle);
		padding: 8px 12px;
		color: var(--text-placeholder);
		font-size: 10px;
	}

	.space-filter-bar {
		display: flex;
		gap: 2px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border-subtle);
	}

	.space-filter-btn {
		border: 0;
		border-radius: 6px;
		background: transparent;
		padding: 4px 12px;
		color: var(--text-tertiary);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 90ms, color 90ms;
	}

	.space-filter-btn:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.space-filter-btn.active {
		background: color-mix(in oklch, var(--brand) 12%, var(--bg-primary) 88%);
		color: var(--brand);
	}

	.command-status {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		gap: 6px;
	}

	.command-status span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.command-status.error {
		color: var(--error-700);
	}

	@keyframes command-enter {
		from { opacity: 0; transform: translateY(-8px) scale(0.985); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}

	@media (max-width: 640px) {
		.command-palette-root {
			align-items: flex-end;
			padding: 0;
			background: var(--overlay-scrim);
		}

		.command-palette {
			width: 100vw;
			max-height: min(82svh, 680px);
			border-right: 0;
			border-bottom: 0;
			border-left: 0;
			border-radius: 16px 16px 0 0;
			animation-name: command-sheet-enter;
		}

		.command-palette::before {
			content: "";
			align-self: center;
			width: 36px;
			height: 4px;
			margin-top: 8px;
			border-radius: 999px;
			background: var(--border-primary);
		}

		.command-input-row {
			padding: 12px 14px 13px;
		}

		.command-shortcut,
		.command-enter {
			display: none;
		}

		.command-result {
			min-height: 58px;
			gap: 6px;
			padding: 8px 8px;
		}

		.command-type-mark {
			width: 32px;
			height: 32px;
		}

		.command-pin-btn,
		.command-pin-btn:not(.pinned) {
			width: 44px;
			height: 44px;
			opacity: 1;
		}

		.command-ungroup-btn {
			opacity: 1;
		}

		.command-footer {
			padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
		}
	}

	@keyframes command-sheet-enter {
		from { opacity: 0; transform: translateY(14px); }
		to { opacity: 1; transform: translateY(0); }
	}

	@media (prefers-reduced-motion: reduce) {
		.command-palette,
		.command-results,
		.command-result {
			animation: none;
			transition: none;
		}
	}
</style>
