<script lang="ts">
import { fade, scale, slide } from "svelte/transition";
import { X } from "lucide-svelte";

const {
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: import("svelte").Snippet;
} = $props();
</script>

{#if open}
  <!-- Overlay layer -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-4"
    in:fade={{ duration: 150 }}
    out:fade={{ duration: 150 }}
  >
    <!-- Backdrop -->
    <div
      class="absolute inset-0 bg-black/40"
      onclick={onClose}
      aria-hidden="true"
    ></div>

    <!-- Desktop: centered modal -->
    <div
      class="hidden lg:block relative w-full max-w-[480px] rounded-xl border border-border-subtle bg-bg-primary shadow-2xl overflow-hidden"
      transition:scale={{ duration: 200, start: 0.95, easing: (t: number) => t }}
    >
      <div class="flex flex-col h-full">
        <div class="h-9 flex items-center justify-between px-3 border-b border-border-subtle text-[10px] font-medium uppercase tracking-wider text-text-tertiary select-none">
          <span>Settings</span>
          <button
            type="button"
            class="flex items-center justify-center w-6 h-6 rounded-[4px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
            onclick={onClose}
            title="Close settings"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
        <div class="flex-1 overflow-y-auto">
          {@render children()}
        </div>
      </div>
    </div>

    <!-- Mobile: bottom sheet -->
    <div
      class="lg:hidden relative w-full max-w-[480px] rounded-t-xl border-t border-border-subtle bg-bg-primary shadow-2xl overflow-hidden"
      in:slide={{ axis: "y", duration: 200, easing: (t: number) => t }}
      out:slide={{ axis: "y", duration: 150, easing: (t: number) => t * t }}
    >
      <div class="flex flex-col max-h-[70vh]">
        <div class="h-9 flex items-center justify-between px-3 border-b border-border-subtle text-[10px] font-medium uppercase tracking-wider text-text-tertiary select-none shrink-0">
          <span>Settings</span>
          <button
            type="button"
            class="flex items-center justify-center w-6 h-6 rounded-[4px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
            onclick={onClose}
            title="Close settings"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
        <div class="flex-1 overflow-y-auto min-h-0 pb-safe">
          {@render children()}
        </div>
      </div>
    </div>
  </div>
{/if}
