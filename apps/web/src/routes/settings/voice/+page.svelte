<script lang="ts">
import type { VoiceLexiconEntry } from "@neta-art/cohub";
import { Keyboard, Mic, RotateCcw } from "lucide-svelte";
import { onMount } from "svelte";
import { page } from "$app/state";
import { ensureAuth } from "$lib/auth";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import VoiceLexiconEditor from "$lib/components/VoiceLexiconEditor.svelte";
import { sdk } from "$lib/sdk";
import { setCachedUserVoiceInputLexicon } from "$lib/voice-input-lexicon";
import {
	formatVoiceInputShortcut,
	isVoiceInputShortcutRelease,
	readVoiceInputShortcut,
	resetVoiceInputShortcut,
	resetVoiceInputShortcutKeyState,
	type VoiceInputShortcut,
	voiceInputShortcutFromKeyboardEvent,
	writeVoiceInputShortcut,
} from "$lib/voice-input-shortcut";

const currentPath = $derived(page.url.pathname);
const currentSearch = $derived(page.url.search);

let entries = $state<VoiceLexiconEntry[]>([]);
let isLoading = $state(true);
let loadError = $state("");
let shortcut = $state<VoiceInputShortcut | null>(null);
let recordingShortcut = $state(false);
let pendingModifierShortcut = $state<VoiceInputShortcut | null>(null);
const shortcutLabel = $derived(
	shortcut ? formatVoiceInputShortcut(shortcut) : "",
);

function cacheEntries(items: VoiceLexiconEntry[]) {
	entries = items;
	setCachedUserVoiceInputLexicon(items);
}

async function loadVoiceLexicon() {
	if (!(await ensureAuth({ redirectPath: `${currentPath}${currentSearch}` })))
		return;
	isLoading = true;
	loadError = "";
	try {
		const result = await sdk.user.getVoiceLexicon();
		cacheEntries(result.items);
	} catch (error) {
		if (
			await handleUnauthorizedError(error, `${currentPath}${currentSearch}`)
		) {
			return;
		}
		loadError =
			error instanceof Error ? error.message : "Failed to load voice terms";
	} finally {
		isLoading = false;
	}
}

async function addTerm(term: string) {
	const result = await sdk.user.addVoiceLexiconEntry({
		term,
		source: "manual",
	});
	cacheEntries([
		result.item,
		...entries.filter((entry) => entry.id !== result.item.id),
	]);
}

async function updateTerm(entry: VoiceLexiconEntry, term: string) {
	const result = await sdk.user.updateVoiceLexiconEntry(entry.id, {
		term,
		source: entry.source,
		originalText: entry.originalText,
	});
	cacheEntries(
		entries.map((item) => (item.id === entry.id ? result.item : item)),
	);
}

async function deleteTerm(entry: VoiceLexiconEntry) {
	await sdk.user.deleteVoiceLexiconEntry(entry.id);
	cacheEntries(entries.filter((item) => item.id !== entry.id));
}

function saveShortcut(next: VoiceInputShortcut) {
	shortcut = writeVoiceInputShortcut(next);
	recordingShortcut = false;
	pendingModifierShortcut = null;
	resetVoiceInputShortcutKeyState();
}

function beginShortcutRecording() {
	recordingShortcut = true;
	pendingModifierShortcut = null;
}

function cancelShortcutRecording() {
	recordingShortcut = false;
	pendingModifierShortcut = null;
	resetVoiceInputShortcutKeyState();
}

function handleShortcutKeydown(event: KeyboardEvent) {
	if (!recordingShortcut) return;
	event.preventDefault();
	event.stopPropagation();
	if (event.key === "Escape") {
		cancelShortcutRecording();
		return;
	}
	const next = voiceInputShortcutFromKeyboardEvent(event);
	if (next) {
		saveShortcut(next);
		return;
	}
	pendingModifierShortcut = voiceInputShortcutFromKeyboardEvent(event, {
		allowSingleModifier: true,
	});
}

function handleShortcutKeyup(event: KeyboardEvent) {
	if (!recordingShortcut || !pendingModifierShortcut) return;
	event.preventDefault();
	event.stopPropagation();
	if (isVoiceInputShortcutRelease(event, pendingModifierShortcut)) {
		saveShortcut(pendingModifierShortcut);
	}
}

function restoreDefaultShortcut() {
	shortcut = resetVoiceInputShortcut();
	recordingShortcut = false;
	pendingModifierShortcut = null;
	resetVoiceInputShortcutKeyState();
}

onMount(() => {
	shortcut = readVoiceInputShortcut();
	const onKeydown = (event: KeyboardEvent) => handleShortcutKeydown(event);
	const onKeyup = (event: KeyboardEvent) => handleShortcutKeyup(event);
	window.addEventListener("keydown", onKeydown, { capture: true });
	window.addEventListener("keyup", onKeyup, { capture: true });
	void loadVoiceLexicon();
	return () => {
		window.removeEventListener("keydown", onKeydown, { capture: true });
		window.removeEventListener("keyup", onKeyup, { capture: true });
		resetVoiceInputShortcutKeyState();
	};
});
</script>

<svelte:head>
	<title>Voice — Cohub</title>
</svelte:head>

<div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
	<div class="flex-1 p-6 overflow-y-auto">
		<section class="max-w-3xl">
			<div class="border-b border-border-subtle pb-5">
				<div class="flex items-center gap-2.5">
					<Mic class="h-4 w-4 text-text-tertiary" />
					<h1 class="text-[18px] font-semibold text-text-primary tracking-tight">Voice</h1>
				</div>
				<p class="mt-1 max-w-2xl text-[13px] leading-5 text-text-tertiary">
					Manage personal words Cohub should preserve during dictation.
				</p>
			</div>

			<div class="mt-6 rounded-[8px] border border-border-subtle bg-bg-surface p-4">
				<div class="mb-5 border-b border-border-subtle pb-4">
					<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<div class="min-w-0">
							<div class="flex items-center gap-2 text-[12px] font-medium text-text-secondary">
								<Keyboard class="h-3.5 w-3.5 text-text-tertiary" />
								Push-to-talk
							</div>
							<div class="mt-1 text-[13px] text-text-primary">
								{recordingShortcut
									? pendingModifierShortcut
										? formatVoiceInputShortcut(pendingModifierShortcut)
										: "Recording"
									: shortcutLabel}
							</div>
						</div>
						<div class="flex items-center gap-2">
							<button
								type="button"
								onclick={recordingShortcut ? cancelShortcutRecording : beginShortcutRecording}
								class={`inline-flex min-h-9 items-center justify-center rounded-[6px] border px-3 py-2 text-[12px] font-medium transition-colors ${recordingShortcut ? 'border-brand/40 bg-brand/8 text-text-primary' : 'border-border-subtle bg-bg-input text-text-secondary hover:bg-bg-hover hover:text-text-primary'}`}
							>
								{recordingShortcut ? "Cancel" : "Record"}
							</button>
							<button
								type="button"
								onclick={restoreDefaultShortcut}
								class="inline-flex min-h-9 w-9 items-center justify-center rounded-[6px] border border-border-subtle bg-bg-input text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
								title="Reset"
							>
								<RotateCcw class="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
				</div>
				<VoiceLexiconEditor
					{entries}
					loading={isLoading}
					error={loadError}
					emptyText="No personal voice terms yet"
					addPlaceholder="Add a product, person, acronym, or phrase"
					onrefresh={loadVoiceLexicon}
					onadd={addTerm}
					onupdate={updateTerm}
					ondelete={deleteTerm}
				/>
			</div>
		</section>
	</div>
</div>
