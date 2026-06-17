<script lang="ts">
import { Bell, Monitor, Moon, Palette, Sun } from "lucide-svelte";
import {
	getDesktopTaskNotificationPreferences,
	getDesktopTaskNotificationStatus,
	requestDesktopTaskNotificationPermission,
	setDesktopTaskNotificationPreferences,
	type DesktopTaskNotificationPreferences,
	type DesktopTaskNotificationStatus,
} from "$lib/notifications/desktop-task-notifications";
import { getTheme, setTheme } from "$lib/theme.svelte";
import { THEME_OPTIONS, type ThemeMode } from "$lib/theme-registry";

// Reactive — reads from $state-backed store, auto-updates on system changes
const mode = $derived(getTheme());
let notificationStatus = $state<DesktopTaskNotificationStatus>(
	getDesktopTaskNotificationStatus(),
);
let notificationPreferences = $state<DesktopTaskNotificationPreferences>(
	getDesktopTaskNotificationPreferences(),
);
let notificationActionPending = $state(false);

const themeIcon = {
	dark: Moon,
	light: Sun,
	"solarized-dark": Palette,
	"solarized-light": Palette,
	system: Monitor,
} satisfies Record<ThemeMode, typeof Sun>;

function handleThemeChange(mode: ThemeMode) {
	setTheme(mode);
}

// An option is active when it matches the stored mode. System remains
// separate, even though it resolves to the current OS light/dark preference.
function isActive(option: ThemeMode): boolean {
	return mode === option;
}

function updateNotificationPreferences(
	patch: Partial<DesktopTaskNotificationPreferences>,
) {
	notificationPreferences = setDesktopTaskNotificationPreferences(patch);
}

async function enableDesktopNotifications() {
	notificationActionPending = true;
	try {
		notificationStatus = await requestDesktopTaskNotificationPermission();
		notificationPreferences = getDesktopTaskNotificationPreferences();
	} finally {
		notificationActionPending = false;
	}
}
</script>

<svelte:head>
	<title>Appearance — Cohub</title>
</svelte:head>

<div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
  <div class="flex-1 p-6 overflow-y-auto">
    <section class="max-w-xl">
      <h1 class="text-[18px] font-semibold text-text-primary tracking-tight">Appearance</h1>
      <p class="mt-1 text-[13px] text-text-tertiary">
        Choose how Cohub looks on your device.
      </p>

      <div class="mt-6 space-y-2">
        {#each THEME_OPTIONS as option (option.value)}
          {@const active = isActive(option.value)}
          {@const Icon = themeIcon[option.value]}
          <button
            type="button"
            class="w-full flex items-center gap-3 p-3 rounded-[6px] border text-left transition-colors duration-100 {
              active
                ? 'border-brand/40 bg-brand-bg'
                : 'border-border-subtle bg-bg-surface hover:bg-bg-surface-hover'
            }"
            onclick={() => handleThemeChange(option.value)}
          >
            <div class="w-9 h-9 rounded-[5px] flex items-center justify-center shrink-0 {
              active
                ? 'bg-brand/15'
                : 'bg-bg-hover-strong'
            }">
              <Icon class="w-4 h-4 {active ? 'text-brand' : 'text-text-tertiary'}" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-[13px] font-medium {active ? 'text-text-primary' : 'text-text-secondary'}">
                {option.label}
              </div>
              <div class="text-[11px] text-text-tertiary mt-0.5">{option.description}</div>
            </div>
          </button>
        {/each}
      </div>
    </section>

    <section class="mt-8 max-w-xl border-t border-border-subtle pt-6">
      <h2 class="text-[15px] font-semibold text-text-primary tracking-tight">Desktop notifications</h2>
      <p class="mt-1 text-[13px] text-text-tertiary">
        Get browser notifications when Cohub tasks finish while this workspace is open.
      </p>

      <div class="mt-4 rounded-[7px] border border-border-subtle bg-bg-surface p-4">
        <div class="flex items-start gap-3">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[5px] bg-bg-hover-strong">
            <Bell class="h-4 w-4 text-text-tertiary" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-medium text-text-primary">Task completion alerts</div>
            <div class="mt-0.5 text-[11px] text-text-tertiary">
              macOS controls how long browser notifications stay visible. Set your browser notification style to Alerts for persistent banners.
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              {#if notificationStatus === "unsupported"}
                <span class="rounded bg-warning-bg px-2 py-1 text-[11px] text-warning">Not supported in this browser</span>
              {:else if notificationStatus === "denied"}
                <span class="rounded bg-error-bg px-2 py-1 text-[11px] text-error-soft">Blocked by browser settings</span>
              {:else if notificationStatus === "granted"}
                <label class="inline-flex items-center gap-2 text-[12px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={notificationPreferences.enabled}
                    onchange={(event) => updateNotificationPreferences({ enabled: event.currentTarget.checked })}
                  />
                  Enabled
                </label>
              {:else}
                <button
                  type="button"
                  class="rounded-[5px] bg-brand px-3 py-1.5 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50"
                  disabled={notificationActionPending}
                  onclick={enableDesktopNotifications}
                >
                  {notificationActionPending ? "Requesting..." : "Enable notifications"}
                </button>
              {/if}
            </div>
          </div>
        </div>

        <div class="mt-4 grid gap-2 border-t border-border-subtle pt-4 sm:grid-cols-2">
          <label class="flex items-center gap-2 text-[12px] text-text-secondary">
            <input
              type="checkbox"
              checked={notificationPreferences.notifyCompleted}
              disabled={notificationStatus !== "granted" || !notificationPreferences.enabled}
              onchange={(event) => updateNotificationPreferences({ notifyCompleted: event.currentTarget.checked })}
            />
            Completed tasks
          </label>
          <label class="flex items-center gap-2 text-[12px] text-text-secondary">
            <input
              type="checkbox"
              checked={notificationPreferences.notifyFailed}
              disabled={notificationStatus !== "granted" || !notificationPreferences.enabled}
              onchange={(event) => updateNotificationPreferences({ notifyFailed: event.currentTarget.checked })}
            />
            Failed tasks
          </label>
        </div>
      </div>
    </section>
  </div>
</div>
