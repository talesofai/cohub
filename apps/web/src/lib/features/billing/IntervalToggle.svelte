<script lang="ts">
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";
import type { PlanInterval } from "./product";

const {
	value,
	hasYearly,
	yearlySavingsPercent,
	locale,
	onchange,
}: {
	value: PlanInterval;
	hasYearly: boolean;
	yearlySavingsPercent: number | null;
	locale: Locale;
	onchange: (interval: PlanInterval) => void;
} = $props();
</script>

<div class="toggle" role="radiogroup" aria-label={m.purchase_billing_interval({}, { locale })}>
	<button
		type="button"
		role="radio"
		aria-checked={value === "monthly"}
		class="option"
		onclick={() => onchange("monthly")}
	>{m.billing_monthly({}, { locale })}</button>
	<button
		type="button"
		role="radio"
		aria-checked={value === "yearly"}
		class="option"
		disabled={!hasYearly}
		onclick={() => onchange("yearly")}
	>
		{m.billing_yearly({}, { locale })}
		{#if hasYearly && yearlySavingsPercent}
			<span class="save">−{yearlySavingsPercent}%</span>
		{/if}
	</button>
</div>

<style>
	.toggle {
		display: inline-flex;
		padding: 2px;
		border-radius: 7px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-subtle);
		font-size: 12px;
	}
	.option {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 30px;
		padding: 0 12px;
		border-radius: 5px;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: color 150ms, background-color 150ms;
	}
	.option:hover:not(:disabled) {
		color: var(--text-secondary);
	}
	.option[aria-checked="true"] {
		background: var(--bg-input);
		color: var(--text-primary);
		box-shadow: 0 1px 2px oklch(0% 0 0 / 0.08);
	}
	.option:disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}
	.option:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--brand) 45%, transparent);
		outline-offset: 1px;
	}
	.save {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--brand);
	}
	@media (pointer: coarse) {
		.option {
			min-height: 38px;
		}
	}
</style>
