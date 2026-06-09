<script lang="ts">
import type { VoiceLexiconEntry } from "@neta-art/cohub";
import { Mic } from "lucide-svelte";
import { onMount } from "svelte";
import { page } from "$app/state";
import { ensureAuth } from "$lib/auth";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import VoiceLexiconEditor from "$lib/components/VoiceLexiconEditor.svelte";
import { sdk } from "$lib/sdk";
import { setCachedUserVoiceInputLexicon } from "$lib/voice-input-lexicon";

const currentPath = $derived(page.url.pathname);
const currentSearch = $derived(page.url.search);

let entries = $state<VoiceLexiconEntry[]>([]);
let isLoading = $state(true);
let loadError = $state("");

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

onMount(() => {
	void loadVoiceLexicon();
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
