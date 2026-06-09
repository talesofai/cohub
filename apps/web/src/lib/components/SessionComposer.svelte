<script lang="ts">
import type {
	PromptTemplateCatalogEntry,
	VoiceActivityEvent,
	VoiceInputAsrOptions,
	VoiceInputClient,
} from "@neta-art/cohub";
import {
	ArrowUp,
	ChevronDown,
	Mic,
	Plus,
	RefreshCw,
	Square,
	Upload,
	X,
} from "lucide-svelte";
import { onMount } from "svelte";
import SlashCommandMenu, {
	type SlashCommandMenuItem,
} from "$lib/components/SlashCommandMenu.svelte";
import SpaceMentionMenu from "$lib/components/SpaceMentionMenu.svelte";
import {
	COMPOSER_ATTACHMENT_ACCEPT,
	type ComposerAttachment,
} from "$lib/composer-attachments";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import type { SpaceMentionSuggestion } from "$lib/mentions/space";
import {
	buildSpaceMentionMarkdown,
	parseCohubSpaceUrls,
	replaceCohubSpaceUrls,
	type SpaceMentionTextToken,
	tokenizeSpaceMentionText,
} from "$lib/mentions/space";
import {
	getCohubLinkMentionKey,
	resolveCohubLinkMentionLabels,
} from "$lib/mentions/space-link-resolve";
import {
	mergeSpaceMentionSuggestions,
	searchLocalSpaceMentions,
	searchRemoteSpaceMentions,
} from "$lib/mentions/space-search";
import { sdk } from "$lib/sdk";
import {
	entriesFromDataTransfer,
	entriesFromFiles,
	type LocalUploadEntry,
} from "$lib/upload-entries";
import {
	addVoiceInputLexiconTerm,
	getVoiceInputLexicon,
	removeVoiceInputLexiconTerm,
	type VoiceInputLexiconEntry,
} from "$lib/voice-input-lexicon";

type SelectedModel = {
	provider: string;
	id: string;
	name?: string;
};

type Props = {
	value: string;
	disabled?: boolean;
	sending?: boolean;
	isRunning?: boolean;
	aborting?: boolean;
	streamError?: string;
	placeholder?: string;
	attachments?: ComposerAttachment[];
	currentModel?: SelectedModel | null;
	promptTemplates?: PromptTemplateCatalogEntry[];
	promptTemplatesLoaded?: boolean;
	currentSpaceId?: string | null;
	onsubmit: () => void;
	onabort?: () => void;
	onpickattachment?: (
		files: FileList | File[] | LocalUploadEntry[] | null,
	) => void;
	onremoveattachment?: (id: string) => void;
	onModelSelect?: () => void;
};

let {
	value = $bindable(""),
	disabled = false,
	sending = false,
	isRunning = false,
	aborting = false,
	streamError = "",
	placeholder = "Send a message...",
	attachments = [],
	currentModel = null,
	promptTemplates = [],
	promptTemplatesLoaded = true,
	currentSpaceId = null,
	onsubmit,
	onabort,
	onpickattachment,
	onremoveattachment,
	onModelSelect,
}: Props = $props();

let textareaEl = $state<HTMLTextAreaElement | null>(null);
let mentionMirrorEl = $state<HTMLDivElement | null>(null);
let fileInputEl = $state<HTMLInputElement | null>(null);
let isDragOver = $state(false);
let dragCounter = 0;
let isPathDragOver = $state(false);
let showPromptSuggestions = $state(false);
let selectedPromptIndex = $state(0);
let showSpaceMentions = $state(false);
let selectedSpaceMentionIndex = $state(0);
let selectedSpaceMentionId = $state<string | null>(null);
let localSpaceMentionItems = $state<SpaceMentionSuggestion[]>([]);
let remoteSpaceMentionItems = $state<SpaceMentionSuggestion[]>([]);
let spaceMentionLocalDone = $state(true);
let spaceMentionRemoteDone = $state(true);
let spaceMentionRemoteError = $state<string | null>(null);
let spaceMentionSearchToken = 0;
let activeSpaceMentionSearchKey: string | null = null;
let spaceMentionLocalController: AbortController | null = null;
let spaceMentionRemoteController: AbortController | null = null;
let spaceMentionDebounceTimer: number | null = null;
let pastedSpaceResolveController: AbortController | null = null;
let composerRootEl = $state<HTMLDivElement | null>(null);
let spaceMentionTrigger = $state<{
	start: number;
	end: number;
	query: string;
} | null>(null);
let isComposerExpanded = $state(false);
let voiceClient: VoiceInputClient | null = null;
let voiceSessionId = 0;
let voicePrefix = "";
let voiceSuffix = "";
let voiceCommittedText = "";
let voicePartialText = $state("");
let voiceActivity = $state<VoiceActivityEvent | null>(null);
let isVoiceRecording = $state(false);
let isVoiceStarting = $state(false);
let isVoiceFinishing = $state(false);
let voiceStopRequested = false;
let voiceStopReason: "manual" | "hotkey_release" | "vad_endpoint" | "error" =
	"manual";
let voicePushToTalkActive = false;
let voiceError = $state<string | null>(null);
let voiceContinuousMode = $state(false);
let voiceCandidateAlternatives = $state<string[]>([]);
let voiceCandidateStart = 0;
let voiceCandidateEnd = 0;
let voiceUndoSnapshot = $state<string | null>(null);
let voiceContinuousUndoSnapshot: string | null = null;
let voiceLexiconOpen = $state(false);
let voiceLexiconInput = $state("");
let voiceLexiconEntries = $state<VoiceInputLexiconEntry[]>([]);

const hasDraft = $derived(Boolean(value.trim() || attachments.length > 0));
const showAbort = $derived(Boolean(isRunning && !hasDraft));
const submitDisabled = $derived(
	disabled || sending || (!hasDraft && !showAbort),
);

const filteredPromptTemplates = $derived.by<SlashCommandMenuItem[]>(() => {
	const trimmed = value.trimStart();
	if (!trimmed.startsWith("/")) return [];
	if (trimmed.includes("\n")) return [];
	const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
	const query = firstToken.slice(1).toLowerCase();
	const scored: SlashCommandMenuItem[] = [];
	for (const item of promptTemplates) {
		const name = item.name.toLowerCase();
		const description = item.description.toLowerCase();
		const category = item.category?.toLowerCase() ?? "";
		let matchScore = 0;
		if (!query) matchScore = 10;
		else if (name.startsWith(query)) matchScore = 100;
		else if (name.includes(query)) matchScore = 80;
		else if (category.includes(query)) matchScore = 64;
		else if (description.includes(query)) matchScore = 48;
		else continue;
		scored.push({ ...item, matchScore });
	}

	return scored.sort((a, b) => {
		const scoreDelta = (b.matchScore ?? 0) - (a.matchScore ?? 0);
		if (scoreDelta !== 0) return scoreDelta;
		const categoryDelta = (a.category ?? a.scope).localeCompare(
			b.category ?? b.scope,
		);
		if (categoryDelta !== 0) return categoryDelta;
		return a.name.localeCompare(b.name);
	});
});

const slashCommandQuery = $derived.by(() => {
	const trimmed = value.trimStart();
	if (!trimmed.startsWith("/") || trimmed.includes("\n")) return "";
	return (trimmed.split(/\s+/, 1)[0] ?? "").slice(1);
});
const slashCommandActive = $derived.by(() => {
	const trimmed = value.trimStart();
	return (
		trimmed.startsWith("/") && !trimmed.includes("\n") && !/\s/.test(trimmed)
	);
});
const slashCommandLoading = $derived(
	slashCommandActive && !promptTemplatesLoaded,
);

const spaceMentionItems = $derived(
	mergeSpaceMentionSuggestions({
		local: localSpaceMentionItems,
		remote: remoteSpaceMentionItems,
		currentSpaceId,
		limit: 30,
	}),
);
const spaceMentionLoading = $derived(
	!spaceMentionLocalDone || !spaceMentionRemoteDone,
);
const spaceMentionStatus = $derived.by(() => {
	const query = spaceMentionTrigger?.query.trim() ?? "";
	if (!query) return "Mention another space";
	if (spaceMentionRemoteError)
		return `Local results only · ${spaceMentionRemoteError}`;
	if (!spaceMentionRemoteDone)
		return `Local ${localSpaceMentionItems.length} · syncing server…`;
	return `${spaceMentionItems.length} space${spaceMentionItems.length === 1 ? "" : "s"}`;
});
const composerMentionTokens = $derived.by<SpaceMentionTextToken[]>(() =>
	tokenizeSpaceMentionText(value),
);
const composerHasRenderableMentions = $derived(
	composerMentionTokens.some((token) => token.type === "spaceMention"),
);
let isTextareaFocused = $state(false);
const shouldRenderComposerMentionMirror = $derived(
	composerHasRenderableMentions && !isTextareaFocused,
);

// Detect mobile/touch — on mobile, Enter should insert newline, not send
function isMobile(): boolean {
	if (typeof window === "undefined") return false;
	return (
		"ontouchstart" in window ||
		window.matchMedia("(pointer: coarse)").matches ||
		navigator.maxTouchPoints > 0
	);
}

function getViewportHeight(): number {
	if (typeof window === "undefined") return 800;
	return window.visualViewport?.height ?? window.innerHeight;
}

function getTextareaLimits(expanded = isComposerExpanded) {
	const mobile = isMobile();
	const viewportHeight = getViewportHeight();
	const min = expanded ? (mobile ? 144 : 168) : 44;
	const max = expanded
		? Math.min(viewportHeight * (mobile ? 0.58 : 0.7), mobile ? 520 : 720)
		: Math.min(viewportHeight * (mobile ? 0.34 : 0.38), mobile ? 220 : 220);

	return {
		min,
		max: Math.max(min, max),
	};
}

function getDraftLineCount(text: string): number {
	return text.length === 0 ? 1 : text.split(/\r\n|\r|\n/).length;
}

function shouldAutoExpandComposer(scrollHeight: number): boolean {
	const draft = value.trim();
	if (!draft) return false;

	const mobile = isMobile();
	const lineCount = getDraftLineCount(value);
	const compactMax = getTextareaLimits(false).max;

	return (
		lineCount >= (mobile ? 5 : 7) ||
		value.length >= (mobile ? 360 : 560) ||
		scrollHeight > compactMax + 1
	);
}

function shouldAutoCollapseComposer(scrollHeight: number): boolean {
	if (!value.trim()) return true;

	const mobile = isMobile();
	const lineCount = getDraftLineCount(value);
	const compactMax = getTextareaLimits(false).max;

	return (
		lineCount <= (mobile ? 2 : 3) &&
		value.length < (mobile ? 220 : 360) &&
		scrollHeight <= compactMax * 0.78
	);
}

function syncAutoComposerExpansion(scrollHeight: number) {
	if (isComposerExpanded) {
		if (shouldAutoCollapseComposer(scrollHeight)) isComposerExpanded = false;
		return;
	}

	if (shouldAutoExpandComposer(scrollHeight)) isComposerExpanded = true;
}

function resizeTextarea() {
	if (!textareaEl) return;
	textareaEl.style.height = "0px";
	const scrollHeight = textareaEl.scrollHeight;
	syncAutoComposerExpansion(scrollHeight);
	const { min, max } = getTextareaLimits();
	const nextHeight = Math.min(scrollHeight, max);
	textareaEl.style.height = `${Math.max(nextHeight, min)}px`;
	syncMentionMirrorScroll();
}

function syncMentionMirrorScroll() {
	if (!textareaEl || !mentionMirrorEl) return;
	mentionMirrorEl.scrollTop = textareaEl.scrollTop;
	mentionMirrorEl.scrollLeft = textareaEl.scrollLeft;
}

function collapseComposer() {
	if (!isComposerExpanded) return;
	isComposerExpanded = false;
	requestAnimationFrame(resizeTextarea);
}

function submitDraft() {
	if (submitDisabled || !hasDraft) return;
	onsubmit();
	collapseComposer();
}

function applyVoiceText(partialText = "") {
	value = voicePrefix + voiceCommittedText + partialText + voiceSuffix;
	requestAnimationFrame(() => {
		resizeTextarea();
		const cursor =
			voicePrefix.length + voiceCommittedText.length + partialText.length;
		textareaEl?.setSelectionRange(cursor, cursor);
	});
}

function rememberVoiceUndoSnapshot() {
	if (voiceContinuousMode && voiceContinuousUndoSnapshot !== null) {
		voiceUndoSnapshot = voiceContinuousUndoSnapshot;
		return;
	}
	voiceUndoSnapshot = value;
	if (voiceContinuousMode) voiceContinuousUndoSnapshot = value;
}

function resetVoiceCandidates() {
	voiceCandidateAlternatives = [];
	voiceCandidateStart = 0;
	voiceCandidateEnd = 0;
}

function setVoiceCandidates(
	alternatives: string[],
	originalText: string,
	insertedText: string,
) {
	const unique = [originalText, ...alternatives]
		.map((item) => item.trim())
		.filter(
			(item, index, values) =>
				item && item !== insertedText && values.indexOf(item) === index,
		)
		.slice(0, 3);
	voiceCandidateAlternatives = unique;
	voiceCandidateEnd = voicePrefix.length + voiceCommittedText.length;
	voiceCandidateStart = Math.max(
		voicePrefix.length,
		voiceCandidateEnd - insertedText.length,
	);
}

function applyVoiceCandidate(candidate: string) {
	if (!candidate || voiceCandidateEnd < voiceCandidateStart) return;
	value =
		value.slice(0, voiceCandidateStart) +
		candidate +
		value.slice(voiceCandidateEnd);
	voiceCandidateEnd = voiceCandidateStart + candidate.length;
	resetVoiceCandidates();
	requestAnimationFrame(() => {
		textareaEl?.focus();
		textareaEl?.setSelectionRange(voiceCandidateEnd, voiceCandidateEnd);
		resizeTextarea();
	});
}

function undoLastVoiceInput() {
	if (voiceUndoSnapshot === null) return;
	value = voiceUndoSnapshot;
	voiceUndoSnapshot = null;
	voiceContinuousUndoSnapshot = null;
	resetVoiceCandidates();
	requestAnimationFrame(() => {
		textareaEl?.focus();
		resizeTextarea();
	});
}

function refreshVoiceLexicon() {
	voiceLexiconEntries = getVoiceInputLexicon();
}

function addVoiceLexiconInput() {
	const next = addVoiceInputLexiconTerm(voiceLexiconInput, "manual");
	voiceLexiconInput = "";
	voiceLexiconEntries = next;
}

function removeVoiceLexiconEntry(term: string) {
	voiceLexiconEntries = removeVoiceInputLexiconTerm(term);
}

function toggleVoiceContinuousMode() {
	voiceContinuousMode = !voiceContinuousMode;
	if (voiceContinuousMode) {
		voiceContinuousUndoSnapshot = value;
		return;
	}
	voiceContinuousUndoSnapshot = null;
}

function extractVoiceTerms(text: string) {
	const terms = new Set<string>();
	const add = (term: string | null | undefined) => {
		const normalized = term?.replace(/[`*_#[\]()>]/g, "").trim();
		if (!normalized || normalized.length < 2 || normalized.length > 40) return;
		terms.add(normalized);
	};

	add("Cohub");
	add("Neta");
	add(currentModel?.name);
	add(currentModel?.id);
	for (const entry of voiceLexiconEntries) add(entry.term);
	for (const item of promptTemplates.slice(0, 24)) add(item.name);
	for (const token of tokenizeSpaceMentionText(text)) {
		if (token.type === "spaceMention") add(token.label);
	}
	for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9_-]{1,39}\b/g)) {
		add(match[0]);
	}
	return Array.from(terms).slice(0, 40);
}

function buildVoiceAsrOptions(): VoiceInputAsrOptions {
	const contextSource = `${voicePrefix}${voiceSuffix}`.trim();
	const contextText =
		contextSource.length > 0
			? `Current composer context: ${contextSource.slice(-900)}`
			: "User is dictating into the Cohub session composer.";
	return {
		endWindowSizeMs: 600,
		forceToSpeechTimeMs: 1000,
		enableNonstream: true,
		enablePunctuation: true,
		enableItn: true,
		enableDdc: false,
		hotwords: extractVoiceTerms(contextSource),
		contextText,
		contextMessages: [
			currentModel?.name ? `Selected model: ${currentModel.name}` : "",
			attachments.length > 0
				? `Composer has ${attachments.length} attachment(s).`
				: "",
		].filter(Boolean),
		postProcessing: {
			enabled: true,
			normalizeWhitespace: true,
			cleanupFillers: true,
			rewritePunctuation: true,
			applyContextTerms: true,
		},
	};
}

function getVoiceStatusText() {
	if (voiceError) return voiceError;
	if (isVoiceFinishing) return "Finishing";
	if (isVoiceStarting) return "Starting...";
	if (!isVoiceRecording) return "";
	if (!voiceActivity || voiceActivity.state === "waiting")
		return "Waiting for speech";
	if (voiceActivity.state === "silence") return "Finishing";
	return "Listening";
}

function isCurrentVoiceSession(sessionId: number, client: VoiceInputClient) {
	return voiceSessionId === sessionId && voiceClient === client;
}

function canStartVoiceInput() {
	return (
		!disabled &&
		!sending &&
		!showAbort &&
		!voiceClient &&
		!isVoiceStarting &&
		!isVoiceRecording &&
		!isVoiceFinishing
	);
}

function scheduleContinuousVoiceInput(reason: typeof voiceStopReason) {
	if (
		!voiceContinuousMode ||
		reason !== "vad_endpoint" ||
		voiceError ||
		voicePushToTalkActive ||
		disabled ||
		sending ||
		showAbort
	)
		return;
	window.setTimeout(() => {
		if (
			voiceClient ||
			isVoiceStarting ||
			isVoiceRecording ||
			isVoiceFinishing ||
			!voiceContinuousMode
		)
			return;
		void startVoiceInput();
	}, 180);
}

function finishVoiceInputSession(sessionId: number, client: VoiceInputClient) {
	if (!isCurrentVoiceSession(sessionId, client)) {
		client.close();
		return;
	}
	const stopReason = voiceStopReason;
	isVoiceRecording = false;
	isVoiceStarting = false;
	isVoiceFinishing = false;
	voiceStopRequested = false;
	voiceStopReason = "manual";
	voicePushToTalkActive = false;
	client.close();
	voiceClient = null;
	voiceActivity = null;
	if (stopReason !== "vad_endpoint") voiceContinuousUndoSnapshot = null;
	scheduleContinuousVoiceInput(stopReason);
}

async function startVoiceInput() {
	if (!canStartVoiceInput()) return;
	refreshVoiceLexicon();
	rememberVoiceUndoSnapshot();
	resetVoiceCandidates();
	const sessionId = voiceSessionId + 1;
	voiceSessionId = sessionId;
	voiceError = null;
	voiceActivity = null;
	isVoiceFinishing = false;
	isVoiceStarting = true;
	voiceStopRequested = false;
	voiceStopReason = "manual";
	const start = textareaEl?.selectionStart ?? value.length;
	const end = textareaEl?.selectionEnd ?? start;
	voicePrefix = value.slice(0, start);
	voiceSuffix = value.slice(end);
	voiceCommittedText = "";
	voicePartialText = "";
	let client: VoiceInputClient;
	client = sdk.voice.createInputClient(
		{
			onPartial: (text) => {
				if (!isCurrentVoiceSession(sessionId, client)) return;
				voicePartialText = text;
				applyVoiceText(text);
			},
			onFinal: (text, event) => {
				if (!isCurrentVoiceSession(sessionId, client)) return;
				voiceCommittedText += text;
				voicePartialText = "";
				applyVoiceText();
				setVoiceCandidates(event.alternatives, event.originalText ?? "", text);
				for (const term of extractVoiceTerms(text).slice(0, 6)) {
					if (/^[A-Z][A-Za-z0-9_-]{2,39}$/.test(term)) {
						voiceLexiconEntries = addVoiceInputLexiconTerm(term, "auto");
					}
				}
			},
			onVoiceActivity: (event) => {
				if (!isCurrentVoiceSession(sessionId, client)) return;
				voiceActivity = event;
			},
			onEndpoint: () => {
				if (!isCurrentVoiceSession(sessionId, client)) return;
				isVoiceRecording = false;
				isVoiceFinishing = true;
				voiceStopRequested = true;
				voiceStopReason = "vad_endpoint";
			},
			onError: (message) => {
				if (!isCurrentVoiceSession(sessionId, client)) return;
				voiceError = message;
				voiceStopReason = "error";
			},
			onDone: () => {
				finishVoiceInputSession(sessionId, client);
			},
		},
		{
			asr: buildVoiceAsrOptions(),
			vad: {
				enabled: true,
				autoStop: true,
				preRollMs: 400,
				minSpeechMs: 160,
				silenceDurationMs: 2400,
				speechThreshold: 0.008,
				silenceThreshold: 0.005,
				peakThreshold: 0.07,
			},
		},
	);
	voiceClient = client;
	try {
		await client.start();
		if (!isCurrentVoiceSession(sessionId, client)) {
			client.close();
			return;
		}
		isVoiceStarting = false;
		if (voiceStopRequested) {
			isVoiceFinishing = true;
			return;
		}
		isVoiceRecording = true;
	} catch (error) {
		if (!isCurrentVoiceSession(sessionId, client)) {
			client.close();
			return;
		}
		voiceError = error instanceof Error ? error.message : "Voice input failed";
		client.close();
		voiceClient = null;
		isVoiceRecording = false;
		isVoiceStarting = false;
		isVoiceFinishing = false;
		voiceStopRequested = false;
		voiceStopReason = "manual";
		voicePushToTalkActive = false;
		voiceContinuousUndoSnapshot = null;
	}
}

function toggleVoiceInput() {
	if (isVoiceRecording || isVoiceStarting) {
		stopVoiceInput();
		return;
	}
	void startVoiceInput();
}

function stopVoiceInput(reason: "manual" | "hotkey_release" = "manual") {
	const client = voiceClient;
	if (!client || isVoiceFinishing) return;
	voiceStopRequested = true;
	voiceStopReason = reason;
	isVoiceRecording = false;
	isVoiceFinishing = true;
	client.stop(reason);
}

function isVoicePushToTalkKey(event: KeyboardEvent) {
	return (
		event.key === "Alt" || event.code === "AltLeft" || event.code === "AltRight"
	);
}

function isVoicePushToTalkScope(event: KeyboardEvent) {
	if (!composerRootEl) return false;
	const target = event.target;
	if (target instanceof Node && composerRootEl.contains(target)) return true;
	const active = document.activeElement;
	return active instanceof Node && composerRootEl.contains(active);
}

function handleVoicePushToTalkDown(event: KeyboardEvent) {
	if (
		!isVoicePushToTalkKey(event) ||
		event.repeat ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey
	)
		return;
	if (!isVoicePushToTalkScope(event) || !canStartVoiceInput()) return;
	event.preventDefault();
	voicePushToTalkActive = true;
	void startVoiceInput();
}

function handleVoicePushToTalkUp(event: KeyboardEvent) {
	if (!isVoicePushToTalkKey(event) || !voicePushToTalkActive) return;
	event.preventDefault();
	voicePushToTalkActive = false;
	stopVoiceInput("hotkey_release");
}

function releaseVoicePushToTalk() {
	if (!voicePushToTalkActive) return;
	voicePushToTalkActive = false;
	stopVoiceInput("hotkey_release");
}

function applyPromptTemplate(item: SlashCommandMenuItem) {
	const trimmedStart = value.trimStart();
	const leadingWhitespace = value.slice(0, value.length - trimmedStart.length);
	const firstSpace = trimmedStart.indexOf(" ");
	const suffix = firstSpace === -1 ? "" : trimmedStart.slice(firstSpace);
	value = `${leadingWhitespace}/${item.name}${suffix || " "}`;
	showPromptSuggestions = false;
	selectedPromptIndex = 0;
	requestAnimationFrame(() => {
		textareaEl?.focus();
		const pos = value.length;
		textareaEl?.setSelectionRange(pos, pos);
	});
}

function detectSpaceMentionTrigger() {
	if (!textareaEl) return null;
	const cursor = textareaEl.selectionStart;
	if (cursor !== textareaEl.selectionEnd) return null;
	const prefix = value.slice(0, cursor);
	const match = /(^|\s)@([^@\s[\]()]{0,80})$/.exec(prefix);
	if (!match) return null;
	const token = match[2] ?? "";
	const atIndex = cursor - token.length - 1;
	return { start: atIndex, end: cursor, query: token };
}

function abortSpaceMentionSearch() {
	spaceMentionSearchToken += 1;
	spaceMentionLocalController?.abort();
	spaceMentionRemoteController?.abort();
	spaceMentionLocalController = null;
	spaceMentionRemoteController = null;
	if (spaceMentionDebounceTimer != null) {
		window.clearTimeout(spaceMentionDebounceTimer);
		spaceMentionDebounceTimer = null;
	}
}

function resetSpaceMentionSearch() {
	abortSpaceMentionSearch();
	activeSpaceMentionSearchKey = null;
	localSpaceMentionItems = [];
	remoteSpaceMentionItems = [];
	spaceMentionLocalDone = true;
	spaceMentionRemoteDone = true;
	spaceMentionRemoteError = null;
	selectedSpaceMentionIndex = 0;
	selectedSpaceMentionId = null;
}

function selectSpaceMentionIndex(index: number) {
	selectedSpaceMentionIndex = index;
	selectedSpaceMentionId = spaceMentionItems[index]?.spaceId ?? null;
}

function scheduleSpaceMentionSearch(
	trigger: {
		start: number;
		query: string;
	} | null,
) {
	if (!trigger) {
		resetSpaceMentionSearch();
		return;
	}

	const q = trigger.query.trim();
	const searchKey = `${trigger.start}:${currentSpaceId ?? ""}:${q}`;
	if (searchKey === activeSpaceMentionSearchKey) return;

	abortSpaceMentionSearch();
	activeSpaceMentionSearchKey = searchKey;
	spaceMentionLocalDone = false;
	spaceMentionRemoteDone = q.length < 2;
	spaceMentionRemoteError = null;
	const token = spaceMentionSearchToken;
	spaceMentionLocalController = new AbortController();
	void searchLocalSpaceMentions(q, {
		signal: spaceMentionLocalController.signal,
		currentSpaceId,
	})
		.then((items) => {
			if (token !== spaceMentionSearchToken) return;
			localSpaceMentionItems = items;
		})
		.catch((error) => {
			if (error?.name !== "AbortError")
				console.warn("[space-mentions] local search failed", error);
		})
		.finally(() => {
			if (token === spaceMentionSearchToken) spaceMentionLocalDone = true;
		});
	if (q.length < 2) {
		remoteSpaceMentionItems = [];
		return;
	}
	spaceMentionRemoteController = new AbortController();
	spaceMentionDebounceTimer = window.setTimeout(() => {
		void searchRemoteSpaceMentions(q, {
			signal: spaceMentionRemoteController?.signal,
			currentSpaceId,
		})
			.then((items) => {
				if (token !== spaceMentionSearchToken) return;
				remoteSpaceMentionItems = items;
				spaceMentionRemoteError = null;
			})
			.catch((error) => {
				if (token !== spaceMentionSearchToken || error?.name === "AbortError")
					return;
				spaceMentionRemoteError =
					error instanceof Error ? error.message : "server unavailable";
			})
			.finally(() => {
				if (token === spaceMentionSearchToken) spaceMentionRemoteDone = true;
			});
	}, 180);
}

function applySpaceMention(item: SpaceMentionSuggestion) {
	const trigger = spaceMentionTrigger;
	if (!trigger) return;
	const snippet = `${buildSpaceMentionMarkdown({ spaceId: item.spaceId, label: item.name })} `;
	value = value.slice(0, trigger.start) + snippet + value.slice(trigger.end);
	showSpaceMentions = false;
	spaceMentionTrigger = null;
	selectedSpaceMentionIndex = 0;
	selectedSpaceMentionId = null;
	requestAnimationFrame(() => {
		const pos = trigger.start + snippet.length;
		textareaEl?.focus();
		textareaEl?.setSelectionRange(pos, pos);
		resizeTextarea();
	});
}

function hasAttachmentFiles(dataTransfer: DataTransfer | null) {
	if (!dataTransfer) return false;
	return Array.from(dataTransfer.items ?? []).some(
		(item) => item.kind === "file",
	);
}

function handleDragEnter(event: DragEvent) {
	if (!hasAttachmentFiles(event.dataTransfer)) return;
	event.preventDefault();
	dragCounter += 1;
	isDragOver = true;
}

function handleDragOver(event: DragEvent) {
	if (!hasAttachmentFiles(event.dataTransfer)) return;
	event.preventDefault();
	isDragOver = true;
}

function handleDragLeave(event: DragEvent) {
	if (!hasAttachmentFiles(event.dataTransfer)) return;
	event.preventDefault();
	dragCounter = Math.max(0, dragCounter - 1);
	if (dragCounter === 0) {
		isDragOver = false;
	}
}

async function handleDrop(event: DragEvent) {
	if (!hasAttachmentFiles(event.dataTransfer)) return;
	event.preventDefault();
	isDragOver = false;
	dragCounter = 0;
	if (!event.dataTransfer) return;
	onpickattachment?.(await entriesFromDataTransfer(event.dataTransfer));
}

function handlePathDragOver(event: DragEvent) {
	if (!event.dataTransfer?.types.includes("text/cohub-path")) return;
	event.preventDefault();
	event.dataTransfer.dropEffect = "copy";
	isPathDragOver = true;
}

function handlePathDragLeave() {
	isPathDragOver = false;
}

function insertSnippet(snippet: string) {
	if (!textareaEl) {
		const start = value.length;
		value = `${value}${snippet}`;
		return { start, end: value.length };
	}
	const start = textareaEl.selectionStart;
	const end = textareaEl.selectionEnd;
	value = value.slice(0, start) + snippet + value.slice(end);
	requestAnimationFrame(() => {
		const pos = start + snippet.length;
		textareaEl?.setSelectionRange(pos, pos);
		textareaEl?.focus();
		resizeTextarea();
	});
	return { start, end: start + snippet.length };
}

function focusComposer() {
	requestAnimationFrame(() => {
		textareaEl?.focus();
	});
}

function handlePathDrop(event: DragEvent) {
	isPathDragOver = false;
	const path = event.dataTransfer?.getData("text/cohub-path");
	if (!path || !textareaEl) return;
	event.preventDefault();
	insertSnippet(` \`${path}\` `);
}

function handlePaste(event: ClipboardEvent) {
	const clipboardText = event.clipboardData?.getData("text/plain") ?? "";
	const pastedSpaceLinks = clipboardText
		? parseCohubSpaceUrls(clipboardText)
		: [];
	if (pastedSpaceLinks.length > 0) {
		event.preventDefault();
		const known = new Map<string, SpaceMentionSuggestion>();
		for (const item of spaceMentionItems) known.set(item.spaceId, item);
		const converted = replaceCohubSpaceUrls(clipboardText, (link) =>
			link.sessionId ? null : known.get(link.spaceId)?.name,
		);
		const inserted = insertSnippet(converted);
		const unresolved = pastedSpaceLinks.filter(
			(link) => link.sessionId || !known.has(link.spaceId),
		);
		if (unresolved.length > 0) {
			pastedSpaceResolveController?.abort();
			pastedSpaceResolveController = new AbortController();
			void resolveCohubLinkMentionLabels(unresolved, {
				signal: pastedSpaceResolveController.signal,
			})
				.then((labels) => {
					if (labels.size === 0) return;
					const currentSegment = value.slice(inserted.start, inserted.end);
					const resolvedSegment = replaceCohubSpaceUrls(
						clipboardText,
						(link) => {
							const resolved = labels.get(getCohubLinkMentionKey(link));
							if (resolved) return resolved;
							return link.sessionId ? null : known.get(link.spaceId)?.name;
						},
					);
					if (currentSegment !== converted) return;
					value =
						value.slice(0, inserted.start) +
						resolvedSegment +
						value.slice(inserted.end);
					inserted.end = inserted.start + resolvedSegment.length;
					requestAnimationFrame(resizeTextarea);
				})
				.catch((error) => {
					if (error?.name !== "AbortError")
						console.warn("[space-mentions] pasted link resolve failed", error);
				});
		}
		return;
	}

	const files = Array.from(event.clipboardData?.items ?? [])
		.filter((item) => item.kind === "file")
		.map((item) => item.getAsFile())
		.filter((file): file is File => file instanceof File);

	if (files.length === 0) return;
	event.preventDefault();
	onpickattachment?.(entriesFromFiles(files));
}

onMount(() => {
	refreshVoiceLexicon();
	focusComposer();
	const handleComposerInsert = (event: Event) => {
		const custom = event as CustomEvent<{ snippet?: string }>;
		const snippet = custom.detail?.snippet;
		if (!snippet) return;
		insertSnippet(snippet);
	};
	const handleFocusComposer = () => focusComposer();
	const handleViewportResize = () => resizeTextarea();
	window.addEventListener("cohub:composer-focus", handleFocusComposer);
	window.addEventListener("cohub:composer-insert", handleComposerInsert);
	window.addEventListener("keydown", handleVoicePushToTalkDown);
	window.addEventListener("keyup", handleVoicePushToTalkUp);
	window.addEventListener("blur", releaseVoicePushToTalk);
	window.addEventListener("resize", handleViewportResize);
	window.visualViewport?.addEventListener("resize", handleViewportResize);
	return () => {
		window.removeEventListener("cohub:composer-focus", handleFocusComposer);
		window.removeEventListener("cohub:composer-insert", handleComposerInsert);
		window.removeEventListener("keydown", handleVoicePushToTalkDown);
		window.removeEventListener("keyup", handleVoicePushToTalkUp);
		window.removeEventListener("blur", releaseVoicePushToTalk);
		window.removeEventListener("resize", handleViewportResize);
		window.visualViewport?.removeEventListener("resize", handleViewportResize);
		spaceMentionLocalController?.abort();
		spaceMentionRemoteController?.abort();
		pastedSpaceResolveController?.abort();
		voiceClient?.close();
		if (spaceMentionDebounceTimer != null)
			window.clearTimeout(spaceMentionDebounceTimer);
	};
});

$effect(() => {
	value;
	attachments.length;
	isComposerExpanded;
	resizeTextarea();
});

$effect(() => {
	const shouldShow =
		slashCommandActive &&
		!showSpaceMentions &&
		(filteredPromptTemplates.length > 0 || slashCommandLoading);
	showPromptSuggestions = shouldShow;
	if (!shouldShow) {
		selectedPromptIndex = 0;
		return;
	}
	selectedPromptIndex = Math.min(
		selectedPromptIndex,
		Math.max(filteredPromptTemplates.length - 1, 0),
	);
});

$effect(() => {
	const trigger = detectSpaceMentionTrigger();
	spaceMentionTrigger = trigger;
	const activeTrigger = trigger && !slashCommandActive ? trigger : null;
	showSpaceMentions = Boolean(activeTrigger);
	scheduleSpaceMentionSearch(activeTrigger);
});

$effect(() => {
	if (spaceMentionItems.length === 0) {
		selectedSpaceMentionIndex = 0;
		selectedSpaceMentionId = null;
		return;
	}

	if (selectedSpaceMentionId) {
		const index = spaceMentionItems.findIndex(
			(item) => item.spaceId === selectedSpaceMentionId,
		);
		if (index !== -1) {
			selectedSpaceMentionIndex = index;
			return;
		}
	}

	selectedSpaceMentionIndex = Math.min(
		selectedSpaceMentionIndex,
		spaceMentionItems.length - 1,
	);
	selectedSpaceMentionId =
		spaceMentionItems[selectedSpaceMentionIndex]?.spaceId ?? null;
});
</script>

<div bind:this={composerRootEl} class="px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2 sm:px-6 sm:pb-4">
	<div class={`relative mx-auto transition-[max-width] duration-200 ${isComposerExpanded ? 'max-w-5xl' : 'max-w-4xl'}`}>
		{#if streamError}
			<div class="mb-3 rounded-2xl border border-error-soft/25 bg-error-bg px-3 py-2 text-[11px] text-error-soft">
				{streamError}
			</div>
		{/if}

		<form
			class={`relative rounded-[28px] border p-2 shadow-[0_12px_36px_rgba(15,23,42,0.08)] backdrop-blur-md transition-colors ${(isDragOver || isPathDragOver) ? 'border-brand/50 bg-brand/5' : 'border-border-subtle/70 bg-bg-content/92 focus-within:border-brand/25 focus-within:bg-bg-content/96'}`}
			onsubmit={(event) => {
				event.preventDefault();
				submitDraft();
			}}
			ondragenter={handleDragEnter}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
		>
			{#if isDragOver}
				<div class="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-[24px] border border-dashed border-brand/40 bg-bg-primary/82 backdrop-blur-sm">
					<div class="flex items-center gap-2 rounded-full border border-border-subtle bg-bg-elevated px-4 py-2 text-[12px] text-text-secondary">
						<Upload class="h-4 w-4 text-brand" />
						<span>Drop files to attach</span>
					</div>
				</div>
			{/if}

			{#if attachments.length > 0}
				<div
					class={`mb-2 flex flex-wrap gap-2 overflow-y-auto px-3 pb-1 ${isComposerExpanded ? 'max-h-36' : 'max-h-24'}`}
					data-drawer-swipe-ignore
				>
					{#each attachments as attachment (attachment.id)}
						<div class={`group relative shrink-0 overflow-hidden rounded-2xl border border-border-subtle bg-bg-content transition-colors hover:border-border-strong ${attachment.kind === 'image' ? 'h-20 w-20 bg-bg-hover/45' : 'flex h-20 w-40 items-center px-3 py-2'}`}>
							{#if attachment.kind === 'image'}
								<img src={attachment.previewUrl} alt={attachment.name} class="h-full w-full object-contain" />
							{:else}
								<div class="min-w-0 flex-1 pr-4">
									<div class="truncate text-[12px] font-medium leading-4 text-text-primary" title={attachment.kind === 'file' ? attachment.relativePath : attachment.name}>{attachment.kind === 'file' ? attachment.relativePath : attachment.name}</div>
									<div class="mt-0.5 flex items-center gap-1.5 text-[10px] leading-3 text-text-tertiary">
										<span>{attachment.kind === 'file' ? 'File' : 'Text'}</span>
										<span aria-hidden="true">·</span>
										<span>{Math.ceil(attachment.size / 1024)} KB</span>
										{#if attachment.kind === 'file'}
											<span aria-hidden="true">·</span>
											<span>{attachment.status === 'uploading' ? 'Uploading' : attachment.status === 'failed' ? 'Failed' : 'Ready'}</span>
										{/if}
									</div>
								</div>
							{/if}
							<button
								type="button"
								class="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-bg-elevated/90 text-text-tertiary opacity-0 shadow-sm ring-1 ring-border-subtle transition-all hover:text-text-primary group-hover:opacity-100"
								onclick={() => onremoveattachment?.(attachment.id)}
								title="Remove attachment"
							>
								<X class="h-3.5 w-3.5" />
							</button>
						</div>
					{/each}
				</div>
			{/if}

			<div class="flex items-end gap-2">
				<div class="relative min-w-0 flex-1 rounded-[22px] bg-transparent px-3 py-1.5 ring-1 ring-transparent transition-colors focus-within:bg-transparent focus-within:ring-transparent">
					<input
						bind:this={fileInputEl}
						type="file"
						accept={COMPOSER_ATTACHMENT_ACCEPT}
						multiple
						class="hidden"
						onchange={(event) => {
							const files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
							onpickattachment?.(entriesFromFiles(files));
							(event.currentTarget as HTMLInputElement).value = "";
						}}
					/>

					<div class="composer-input-shell relative min-h-[44px]">
						{#if shouldRenderComposerMentionMirror}
							<div
								bind:this={mentionMirrorEl}
								class="composer-mention-mirror pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[14px] leading-6 text-text-primary"
								aria-hidden="true"
							>
								{#each composerMentionTokens as token}
									{#if token.type === 'spaceMention'}<span
										class="composer-space-mention"
										data-space-id={token.spaceId}
									>@{token.label}</span>{:else}{token.text}{/if}
								{/each}
							</div>
						{/if}

						<textarea
							bind:this={textareaEl}
							bind:value
							rows="1"
							placeholder={placeholder}
							class={`relative z-[1] block min-h-[44px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[14px] leading-6 outline-none placeholder:text-text-placeholder ${shouldRenderComposerMentionMirror ? 'text-transparent caret-text-primary selection:bg-brand/22' : 'text-text-primary'}`}
							onpointerdown={() => {
								isTextareaFocused = true;
							}}
							oninput={() => resizeTextarea()}
							onscroll={syncMentionMirrorScroll}
							ondragover={handlePathDragOver}
						ondragleave={handlePathDragLeave}
						ondrop={handlePathDrop}
						onpaste={handlePaste}
							onblur={() => {
							isTextareaFocused = false;
							setTimeout(() => {
								showPromptSuggestions = false;
								showSpaceMentions = false;
							}, 120);
						}}
						onfocus={() => {
							isTextareaFocused = true;
							if (spaceMentionTrigger && !slashCommandActive) showSpaceMentions = true;
							if (slashCommandActive && (filteredPromptTemplates.length > 0 || slashCommandLoading)) {
								showPromptSuggestions = true;
							}
						}}
						onkeydown={(event) => {
							if (event.key === 'Escape' && showSpaceMentions) {
								event.preventDefault();
								showSpaceMentions = false;
								return;
							}

							if (showSpaceMentions) {
								const key = event.key.toLowerCase();
								const isEmacsNext = event.ctrlKey && !event.metaKey && !event.altKey && key === 'n';
								const isEmacsPrevious = event.ctrlKey && !event.metaKey && !event.altKey && key === 'p';
								if (spaceMentionItems.length > 0 && (event.key === 'ArrowDown' || isEmacsNext)) {
									event.preventDefault();
									selectSpaceMentionIndex(Math.min(selectedSpaceMentionIndex + 1, spaceMentionItems.length - 1));
									return;
								}
								if (spaceMentionItems.length > 0 && (event.key === 'ArrowUp' || isEmacsPrevious)) {
									event.preventDefault();
									selectSpaceMentionIndex(Math.max(selectedSpaceMentionIndex - 1, 0));
									return;
								}
								if (spaceMentionItems.length > 0 && event.key === 'Home') {
									event.preventDefault();
									selectSpaceMentionIndex(0);
									return;
								}
								if (spaceMentionItems.length > 0 && event.key === 'End') {
									event.preventDefault();
									selectSpaceMentionIndex(spaceMentionItems.length - 1);
									return;
								}
								if (
									spaceMentionItems.length > 0 &&
									(event.key === 'Tab' ||
										(event.key === 'Enter' && !isComposingKeyboardEvent(event)))
								) {
									if (!(event.key === 'Enter' && event.shiftKey)) {
										event.preventDefault();
										const selected = spaceMentionItems[selectedSpaceMentionIndex];
										if (selected) applySpaceMention(selected);
										return;
									}
								}
							}

							if (event.key === 'Escape' && showPromptSuggestions) {
								event.preventDefault();
								showPromptSuggestions = false;
								return;
							}

							if (showPromptSuggestions && (filteredPromptTemplates.length > 0 || slashCommandLoading)) {
								const key = event.key.toLowerCase();
								const isEmacsNext = event.ctrlKey && !event.metaKey && !event.altKey && key === 'n';
								const isEmacsPrevious = event.ctrlKey && !event.metaKey && !event.altKey && key === 'p';

								if (filteredPromptTemplates.length > 0 && (event.key === 'ArrowDown' || isEmacsNext)) {
									event.preventDefault();
									selectedPromptIndex = Math.min(selectedPromptIndex + 1, filteredPromptTemplates.length - 1);
									return;
								}
								if (filteredPromptTemplates.length > 0 && (event.key === 'ArrowUp' || isEmacsPrevious)) {
									event.preventDefault();
									selectedPromptIndex = Math.max(selectedPromptIndex - 1, 0);
									return;
								}
								if (filteredPromptTemplates.length > 0 && event.key === 'Home') {
									event.preventDefault();
									selectedPromptIndex = 0;
									return;
								}
								if (filteredPromptTemplates.length > 0 && event.key === 'End') {
									event.preventDefault();
									selectedPromptIndex = filteredPromptTemplates.length - 1;
									return;
								}
								if (
									filteredPromptTemplates.length > 0 &&
									(event.key === 'Tab' ||
										(event.key === 'Enter' && !isComposingKeyboardEvent(event)))
								) {
									if (!(event.key === 'Enter' && event.shiftKey)) {
										event.preventDefault();
										const selected = filteredPromptTemplates[selectedPromptIndex];
										if (selected) applyPromptTemplate(selected);
										return;
									}
								}
								if (event.key === 'Escape') {
									showPromptSuggestions = false;
									return;
								}
							}

							if (event.key === 'Escape') {
								event.preventDefault();
								if (isComposerExpanded) {
									isComposerExpanded = false;
									requestAnimationFrame(resizeTextarea);
									return;
								}
								textareaEl?.blur();
								return;
							}

							if (
								(event.metaKey || event.ctrlKey) &&
								event.key === 'Enter' &&
								!isComposingKeyboardEvent(event)
							) {
								event.preventDefault();
								submitDraft();
								return;
							}

							if (
								event.key === 'Enter' &&
								!event.shiftKey &&
								!isComposingKeyboardEvent(event)
							) {
								if (isMobile()) return;
								event.preventDefault();
								submitDraft();
							}
						}}
						></textarea>
					</div>

					<SlashCommandMenu
						open={showPromptSuggestions}
						items={filteredPromptTemplates}
						query={slashCommandQuery}
						selectedIndex={selectedPromptIndex}
						loading={slashCommandLoading}
						onhighlight={(index) => {
							selectedPromptIndex = index;
						}}
						onselect={applyPromptTemplate}
					/>

					<SpaceMentionMenu
						open={showSpaceMentions}
						items={spaceMentionItems}
						query={spaceMentionTrigger?.query ?? ""}
						selectedIndex={selectedSpaceMentionIndex}
						loading={spaceMentionLoading}
						status={spaceMentionStatus}
						onhighlight={(index) => {
							selectSpaceMentionIndex(index);
						}}
						onselect={applySpaceMention}
					/>

					<div class="mt-1.5 flex flex-wrap items-center justify-between gap-2">
						<div class="flex min-w-0 flex-wrap items-center gap-1">
							<button
								type="button"
								class="-ml-2 flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
								onclick={() => fileInputEl?.click()}
								disabled={disabled || sending}
								title="Add files"
							>
								<Plus class="h-[17px] w-[17px]" />
							</button>

							<div class="relative">
								<button
									type="button"
									class={`flex h-7 items-center rounded-full border px-2 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${voiceLexiconOpen ? 'border-brand/35 bg-brand/8 text-text-primary' : 'border-border-subtle text-text-tertiary hover:bg-bg-hover hover:text-text-primary'}`}
									onclick={() => {
										refreshVoiceLexicon();
										voiceLexiconOpen = !voiceLexiconOpen;
									}}
									disabled={disabled || sending}
									title="Voice terms"
								>
									Terms
								</button>
								{#if voiceLexiconOpen}
									<div class="absolute bottom-8 left-0 z-30 w-64 rounded-lg border border-border-subtle bg-bg-elevated p-2 shadow-lg">
										<div class="flex gap-1">
											<input
												bind:value={voiceLexiconInput}
												class="min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-content px-2 py-1 text-[12px] text-text-primary outline-none focus:border-brand/35"
												placeholder="Add term"
												onkeydown={(event) => {
													if (event.key === 'Enter') {
														event.preventDefault();
														addVoiceLexiconInput();
													}
												}}
											/>
											<button
												type="button"
												class="rounded-md bg-text-primary px-2 text-[11px] text-bg-primary disabled:opacity-50"
												disabled={!voiceLexiconInput.trim()}
												onclick={addVoiceLexiconInput}
											>
												Add
											</button>
										</div>
										<div class="mt-2 max-h-36 overflow-y-auto">
											{#if voiceLexiconEntries.length === 0}
												<div class="px-1 py-2 text-[11px] text-text-placeholder">No terms</div>
											{:else}
												{#each voiceLexiconEntries as entry (entry.term)}
													<div class="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-[12px] text-text-secondary hover:bg-bg-hover">
														<span class="min-w-0 truncate">{entry.term}</span>
														<button
															type="button"
															class="shrink-0 text-text-tertiary hover:text-text-primary"
															title="Remove"
															onclick={() => removeVoiceLexiconEntry(entry.term)}
														>
															<X class="h-3.5 w-3.5" />
														</button>
													</div>
												{/each}
											{/if}
										</div>
									</div>
								{/if}
							</div>

							<button
								type="button"
								class={`flex h-7 items-center rounded-full border px-2 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${voiceContinuousMode ? 'border-brand/35 bg-brand/8 text-text-primary' : 'border-border-subtle text-text-tertiary hover:bg-bg-hover hover:text-text-primary'}`}
								onclick={toggleVoiceContinuousMode}
								disabled={disabled || sending}
								title="Continuous dictation"
								aria-pressed={voiceContinuousMode}
							>
								Loop
							</button>

							{#if onModelSelect}
								<button
									type="button"
									class="flex h-7 items-center gap-1 rounded-full border border-border-subtle px-2 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
									onclick={() => onModelSelect?.()}
									disabled={disabled || sending}
									title="Select model"
								>
									<span class="max-w-[120px] truncate">
										{currentModel?.name ?? currentModel?.id ?? 'Model'}
									</span>
									<ChevronDown class="h-3 w-3 opacity-50" />
								</button>
							{/if}
						</div>

						<div class="flex min-w-0 items-center gap-2">
							{#if voiceCandidateAlternatives.length > 0 || voiceUndoSnapshot !== null}
								<div class="flex max-w-[46vw] flex-wrap items-center justify-end gap-1 overflow-hidden sm:max-w-[280px]">
									{#each voiceCandidateAlternatives as candidate}
										<button
											type="button"
											class="max-w-[92px] truncate rounded-full border border-border-subtle px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
											title={candidate}
											onclick={() => applyVoiceCandidate(candidate)}
										>
											{candidate}
										</button>
									{/each}
									{#if voiceUndoSnapshot !== null}
										<button
											type="button"
											class="flex h-7 w-7 items-center justify-center rounded-full text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
											title="Undo voice input"
											onclick={undoLastVoiceInput}
										>
											<RefreshCw class="h-3.5 w-3.5" />
										</button>
									{/if}
								</div>
							{/if}
							{#if isVoiceStarting || isVoiceRecording || isVoiceFinishing || voiceError}
								<span class={`max-w-[160px] truncate text-[11px] leading-none ${voiceError ? 'text-error-soft' : 'text-text-placeholder'}`}>
									{getVoiceStatusText()}
								</span>
							{/if}
							<button
								type="button"
								class={`voice-record-button relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-50 ${isVoiceRecording ? 'border-brand/45 bg-brand text-brand-contrast-fg shadow-sm' : (isVoiceStarting || isVoiceFinishing) ? 'border-border-subtle bg-bg-hover-strong text-text-secondary' : 'border-transparent text-text-tertiary hover:bg-bg-hover hover:text-text-primary'}`}
								disabled={disabled || sending || showAbort || isVoiceFinishing}
								title={isVoiceRecording || isVoiceStarting ? "Stop voice input" : "Start voice input"}
								aria-label={isVoiceRecording || isVoiceStarting ? "Stop voice input" : "Start voice input"}
								aria-pressed={isVoiceRecording}
								oncontextmenu={(event) => event.preventDefault()}
								onclick={toggleVoiceInput}
							>
								<Mic class="h-4 w-4" />
							</button>
							<button
								type={showAbort ? "button" : "submit"}
								disabled={showAbort ? disabled || aborting : submitDisabled}
								class={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all hover:scale-[1.02] disabled:scale-100 disabled:cursor-not-allowed disabled:bg-bg-hover-strong disabled:text-text-disabled ${showAbort ? 'bg-text-primary text-bg-primary hover:bg-text-secondary' : 'bg-brand text-brand-contrast-fg hover:bg-brand-hover'}`}
								title={showAbort ? "Stop generation" : "Send"}
								aria-label={showAbort ? "Stop generation" : "Send"}
								onclick={() => {
									if (showAbort) onabort?.();
								}}
							>
								{#if showAbort}
									<Square class="h-3.5 w-3.5 fill-current" />
								{:else}
									<ArrowUp class="h-4 w-4" />
								{/if}
							</button>
						</div>
					</div>
				</div>
			</div>
		</form>
	</div>
</div>

<style>
	.voice-record-button {
		touch-action: manipulation;
		-webkit-user-select: none;
		user-select: none;
		-webkit-touch-callout: none;
	}

	.composer-input-shell textarea,
	.composer-mention-mirror {
		font: inherit;
		font-size: 14px;
		line-height: 1.5rem;
		letter-spacing: inherit;
		tab-size: 4;
	}

	.composer-mention-mirror {
		min-height: 44px;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.composer-space-mention {
		display: inline;
		box-decoration-break: clone;
		-webkit-box-decoration-break: clone;
		border: 1px solid color-mix(in srgb, var(--brand) 24%, transparent);
		border-radius: 999px;
		background:
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--brand) 13%, transparent),
				color-mix(in srgb, var(--brand) 8%, transparent)
			),
			var(--bg-content);
		color: var(--brand);
		font-weight: 520;
		padding: 0.03rem 0.42rem 0.08rem;
		text-shadow: 0 0 0 color-mix(in srgb, var(--brand) 44%, transparent);
		white-space: pre-wrap;
	}

	:global([data-theme="light"]) .composer-space-mention {
		background:
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--brand) 10%, white),
				color-mix(in srgb, var(--brand) 5%, white)
			),
			var(--bg-content);
	}
</style>
