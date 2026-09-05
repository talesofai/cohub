<script lang="ts">
import { Menu } from "lucide-svelte";
import { page } from "$app/state";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { uiState } from "$lib/stores/ui.svelte";

const locale = $derived(getLocale());

function settingsTitle(section: string): string {
	const options = { locale };
	switch (section) {
		case "general":
			return m.nav_general({}, options);
		case "activity":
			return m.nav_activity({}, options);
		case "referrals":
			return m.nav_referrals({}, options);
		case "billing":
		case "balance":
			return m.nav_billing({}, options);
		case "rules":
			return m.nav_user_rules({}, options);
		case "channels":
			return m.nav_channels({}, options);
		default:
			return m.nav_settings({}, options);
	}
}

const currentSection = $derived(
	page.url.pathname.split("/").filter(Boolean)[1] ?? "general",
);
const title = $derived(settingsTitle(currentSection));

const { children } = $props();
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
	<header class="flex h-11 shrink-0 items-center border-b border-border-subtle bg-bg-primary px-2 lg:hidden">
		<button
			type="button"
			class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
			aria-label={m.nav_open_settings({}, { locale })}
			title={m.nav_open_settings({}, { locale })}
			onclick={() => {
				uiState.mobileDrawerOpen = true;
			}}
		>
			<Menu class="h-[18px] w-[18px]" />
		</button>
		<div class="min-w-0 flex-1 truncate px-2 text-[13px] font-medium text-text-primary">{title}</div>
	</header>

	{@render children?.()}
</div>
