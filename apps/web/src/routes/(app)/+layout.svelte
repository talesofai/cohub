<script lang="ts">
import "../../app.css";
import { onMount } from "svelte";
import { page } from "$app/state";
import { scheduleCacheCleanup } from "$lib/cache/cleanup";
import BillingConversionCenter from "$lib/components/BillingConversionCenter.svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import CommandPalette from "$lib/components/CommandPalette.svelte";
import HelpPanel from "$lib/components/HelpPanel.svelte";
import MediaLightbox from "$lib/components/MediaLightbox.svelte";
import MobileSidebarDrawer from "$lib/components/MobileSidebarDrawer.svelte";
import Sidebar from "$lib/components/Sidebar.svelte";
import TurnNotificationStack from "$lib/components/TurnNotificationStack.svelte";
import {
	type DrawerGestureDirection,
	type DrawerGesturePhase,
	getDrawerOffsetFromDrag,
	getRightDrawerOffsetFromDrag,
	MOBILE_DRAWER_WIDTH_PX,
	resolveDrawerGestureDirection,
	shouldKeepDrawerOpen,
	shouldKeepRightDrawerOpen,
	shouldOpenDrawer,
	shouldOpenRightDrawer,
	shouldStartDrawerGesture,
	shouldStartRightDrawerGesture,
} from "$lib/gestures/drawer-swipe";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { DESKTOP_SHELL_MIN_WIDTH_PX } from "$lib/layout/breakpoints";
import { DURATION_DRAWER_OUT } from "$lib/motion.svelte";
import { authStore } from "$lib/stores/auth.svelte";
import { turnNotifications } from "$lib/stores/turn-notifications.svelte";
import {
	LEFT_SIDEBAR_MAX,
	LEFT_SIDEBAR_MIN,
	uiState,
} from "$lib/stores/ui.svelte";

const { children } = $props();

const currentPath = $derived(page.url.pathname);
const sidebarMode = $derived(
	currentPath.startsWith("/settings") ? "settings" : "space",
);
const currentLayoutSpaceId = $derived.by(() => {
	const data = page.data as { spaceId?: unknown };
	if (typeof data.spaceId === "string" && data.spaceId.length > 0) {
		return data.spaceId;
	}
	if (!currentPath.startsWith("/spaces/")) return null;
	const id = page.params.id;
	return typeof id === "string" && id.length > 0 ? id : null;
});

let showHelpPanel = $state(false);
let authReady = $state(false);
let gesturePhase = $state<DrawerGesturePhase>("idle");
let gestureDirection = $state<DrawerGestureDirection>(null);
let activeTouchId = $state<number | null>(null);
let activeGestureType = $state<"left" | "right" | null>(null);
let pointerStartX = $state(0);
let pointerStartY = $state(0);
let lastPointerX = $state(0);
let lastPointerTime = $state(0);
let dragOffsetPx = $state(0);
let velocityX = $state(0);
let isDragging = $state(false);
let leftSidebarResizeCleanup: (() => void) | null = null;
let vConsole: InstanceType<typeof import("vconsole").default> | null = null;

function isEditableShortcutTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	return Boolean(
		target.closest(
			'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
		),
	);
}

function shouldEnableVConsole() {
	if (import.meta.env.DEV) return true;

	const hostname = window.location.hostname;
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname.startsWith("dev.") ||
		hostname.startsWith("dev-") ||
		hostname.includes("-dev.")
	);
}

const isDrawerVisible = $derived(
	isDragging || gesturePhase === "settling" || uiState.mobileDrawerOpen,
);
const isRightDrawerVisible = $derived(
	uiState.rightIsDragging ||
		gesturePhase === "settling" ||
		uiState.mobileRightDrawerOpen,
);

function resetGestureState() {
	gesturePhase = "idle";
	gestureDirection = null;
	activeTouchId = null;
	activeGestureType = null;
	pointerStartX = 0;
	pointerStartY = 0;
	lastPointerX = 0;
	lastPointerTime = 0;
	dragOffsetPx = 0;
	uiState.rightDragOffsetPx = 0;
	uiState.rightIsDragging = false;
	velocityX = 0;
	isDragging = false;
}

function beginSettling(open: boolean) {
	gesturePhase = "settling";
	if (activeGestureType === "right") {
		uiState.mobileRightDrawerOpen = open;
	} else {
		uiState.mobileDrawerOpen = open;
	}
	isDragging = false;
	uiState.rightIsDragging = false;
	activeTouchId = null;
	activeGestureType = null;
	gestureDirection = null;
	velocityX = 0;
	lastPointerTime = 0;
	lastPointerX = 0;
	pointerStartX = 0;
	pointerStartY = 0;
}

function findTrackedTouch(touches: TouchList) {
	if (activeTouchId === null) return null;
	for (const touch of Array.from(touches)) {
		if (touch.identifier === activeTouchId) return touch;
	}
	return null;
}

function handleTouchStart(e: TouchEvent) {
	if (window.innerWidth >= DESKTOP_SHELL_MIN_WIDTH_PX || activeTouchId !== null)
		return;
	const touch = e.changedTouches[0];
	if (!touch) return;

	// Try right drawer first (right edge), then left drawer
	if (
		shouldStartRightDrawerGesture({
			isOpen: uiState.mobileRightDrawerOpen,
			target: e.target,
			viewportWidth: window.innerWidth,
			touchStartX: touch.clientX,
			otherDrawerOpen: uiState.mobileDrawerOpen,
		})
	) {
		activeTouchId = touch.identifier;
		activeGestureType = "right";
		gesturePhase = "tracking";
		gestureDirection = null;
		pointerStartX = touch.clientX;
		pointerStartY = touch.clientY;
		lastPointerX = touch.clientX;
		lastPointerTime = e.timeStamp;
		uiState.rightDragOffsetPx = uiState.mobileRightDrawerOpen
			? MOBILE_DRAWER_WIDTH_PX
			: 0;
		uiState.rightIsDragging = false;
		velocityX = 0;
		isDragging = false;
		return;
	}

	if (
		!shouldStartDrawerGesture({
			isOpen: uiState.mobileDrawerOpen,
			target: e.target,
			viewportWidth: window.innerWidth,
			touchStartX: touch.clientX,
			otherDrawerOpen: uiState.mobileRightDrawerOpen,
		})
	) {
		return;
	}

	activeTouchId = touch.identifier;
	activeGestureType = "left";
	gesturePhase = "tracking";
	gestureDirection = null;
	pointerStartX = touch.clientX;
	pointerStartY = touch.clientY;
	lastPointerX = touch.clientX;
	lastPointerTime = e.timeStamp;
	dragOffsetPx = uiState.mobileDrawerOpen ? MOBILE_DRAWER_WIDTH_PX : 0;
	velocityX = 0;
	isDragging = false;
}

function handleTouchMove(e: TouchEvent) {
	const touch = findTrackedTouch(e.touches);
	if (!touch) return;

	const dx = touch.clientX - pointerStartX;
	const dy = touch.clientY - pointerStartY;
	const absDx = Math.abs(dx);
	const absDy = Math.abs(dy);

	if (gestureDirection === null) {
		const resolvedDirection = resolveDrawerGestureDirection({ absDx, absDy });
		if (resolvedDirection === null) {
			return;
		}
		if (resolvedDirection === "vertical") {
			resetGestureState();
			return;
		}
		gestureDirection = resolvedDirection;
	}

	const deltaTime = Math.max(e.timeStamp - lastPointerTime, 1);
	velocityX = (touch.clientX - lastPointerX) / deltaTime;
	lastPointerX = touch.clientX;
	lastPointerTime = e.timeStamp;

	if (activeGestureType === "right") {
		const nextOffsetPx = getRightDrawerOffsetFromDrag({
			isOpen: uiState.mobileRightDrawerOpen,
			deltaX: dx,
		});

		if (!uiState.mobileRightDrawerOpen && nextOffsetPx <= 0) return;
		if (
			uiState.mobileRightDrawerOpen &&
			nextOffsetPx >= MOBILE_DRAWER_WIDTH_PX &&
			dx <= 0
		)
			return;

		isDragging = true;
		uiState.rightIsDragging = true;
		uiState.rightDragOffsetPx = nextOffsetPx;
		gesturePhase = uiState.mobileRightDrawerOpen
			? "dragging-close"
			: "dragging-open";
	} else {
		const nextOffsetPx = getDrawerOffsetFromDrag({
			isOpen: uiState.mobileDrawerOpen,
			deltaX: dx,
		});

		if (!uiState.mobileDrawerOpen && nextOffsetPx <= 0) return;
		if (
			uiState.mobileDrawerOpen &&
			nextOffsetPx >= MOBILE_DRAWER_WIDTH_PX &&
			dx >= 0
		)
			return;

		isDragging = true;
		dragOffsetPx = nextOffsetPx;
		gesturePhase = uiState.mobileDrawerOpen
			? "dragging-close"
			: "dragging-open";
	}

	if (e.cancelable) {
		e.preventDefault();
	}
}

function finalizeGesture() {
	if (!isDragging) {
		resetGestureState();
		return;
	}

	let shouldOpen: boolean;
	if (activeGestureType === "right") {
		shouldOpen = uiState.mobileRightDrawerOpen
			? shouldKeepRightDrawerOpen({
					offsetPx: uiState.rightDragOffsetPx,
					velocityX,
				})
			: shouldOpenRightDrawer({
					offsetPx: uiState.rightDragOffsetPx,
					velocityX,
				});
	} else {
		shouldOpen = uiState.mobileDrawerOpen
			? shouldKeepDrawerOpen({ offsetPx: dragOffsetPx, velocityX })
			: shouldOpenDrawer({ offsetPx: dragOffsetPx, velocityX });
	}

	beginSettling(shouldOpen);
}

function handleTouchEnd(e: TouchEvent) {
	const touch = findTrackedTouch(e.changedTouches);
	if (!touch) return;
	finalizeGesture();
}

function handleTouchCancel(e: TouchEvent) {
	const touch = findTrackedTouch(e.changedTouches);
	if (!touch) return;
	finalizeGesture();
}

function beginLeftSidebarResize(event: PointerEvent) {
	if (window.innerWidth < DESKTOP_SHELL_MIN_WIDTH_PX) return;
	event.preventDefault();

	const target = event.currentTarget as HTMLElement | null;
	target?.setPointerCapture?.(event.pointerId);
	leftSidebarResizeCleanup?.();

	const startX = event.clientX;
	const startWidth = uiState.leftSidebarWidth;
	const minMainWidth = 640;

	const onPointerMove = (moveEvent: PointerEvent) => {
		const delta = moveEvent.clientX - startX;
		const viewportLimit = window.innerWidth - minMainWidth;
		const nextWidth = Math.min(
			LEFT_SIDEBAR_MAX,
			Math.max(LEFT_SIDEBAR_MIN, Math.min(startWidth + delta, viewportLimit)),
		);
		uiState.setLeftSidebarWidth(nextWidth);
	};

	const stop = () => {
		if (target?.hasPointerCapture?.(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}
		document.body.classList.remove("sidebar-resizing");
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", stop);
		window.removeEventListener("pointercancel", stop);
		if (leftSidebarResizeCleanup === stop) {
			leftSidebarResizeCleanup = null;
		}
	};

	leftSidebarResizeCleanup = stop;
	document.body.classList.add("sidebar-resizing");
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", stop);
	window.addEventListener("pointercancel", stop);
}

$effect(() => {
	function openHelpPanel() {
		showHelpPanel = true;
	}
	function handleKeydown(e: KeyboardEvent) {
		if (e.defaultPrevented || isComposingKeyboardEvent(e)) return;
		if (e.key === "Escape" && showHelpPanel) {
			e.preventDefault();
			showHelpPanel = false;
			return;
		}
		if (e.key === "?" && !e.altKey && !e.metaKey && !e.ctrlKey) {
			if (isEditableShortcutTarget(e.target)) return;
			e.preventDefault();
			showHelpPanel = true;
		}
	}
	window.addEventListener("cohub:open-help-panel", openHelpPanel);
	window.addEventListener("keydown", handleKeydown, { capture: true });
	return () => {
		window.removeEventListener("cohub:open-help-panel", openHelpPanel);
		window.removeEventListener("keydown", handleKeydown, { capture: true });
	};
});

// Close drawer on Escape
$effect(() => {
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			if (uiState.mobileDrawerOpen) uiState.mobileDrawerOpen = false;
			if (uiState.mobileRightDrawerOpen) uiState.mobileRightDrawerOpen = false;
		}
	}
	window.addEventListener("keydown", handleKeydown);
	return () => window.removeEventListener("keydown", handleKeydown);
});

$effect(() => {
	function onTouchStart(e: TouchEvent) {
		handleTouchStart(e);
	}
	function onTouchMove(e: TouchEvent) {
		handleTouchMove(e);
	}
	function onTouchEnd(e: TouchEvent) {
		handleTouchEnd(e);
	}
	function onTouchCancel(e: TouchEvent) {
		handleTouchCancel(e);
	}

	document.addEventListener("touchstart", onTouchStart, { passive: true });
	document.addEventListener("touchmove", onTouchMove, { passive: false });
	document.addEventListener("touchend", onTouchEnd, { passive: true });
	document.addEventListener("touchcancel", onTouchCancel, { passive: true });

	return () => {
		document.removeEventListener("touchstart", onTouchStart);
		document.removeEventListener("touchmove", onTouchMove);
		document.removeEventListener("touchend", onTouchEnd);
		document.removeEventListener("touchcancel", onTouchCancel);
	};
});

$effect(() => {
	if (gesturePhase !== "settling") return;

	const timer = window.setTimeout(() => {
		if (gesturePhase === "settling") {
			gesturePhase = "idle";
			if (!uiState.mobileRightDrawerOpen) uiState.rightDragOffsetPx = 0;
			if (!uiState.mobileDrawerOpen) dragOffsetPx = 0;
		}
	}, DURATION_DRAWER_OUT);

	return () => window.clearTimeout(timer);
});

$effect(() => {
	uiState.loadLayoutPrefs(currentLayoutSpaceId);
	turnNotifications.syncActiveSessionPresence();
});

// Lock body scroll when drawer is open
$effect(() => {
	if (
		uiState.mobileDrawerOpen ||
		uiState.mobileRightDrawerOpen ||
		isDragging ||
		uiState.rightIsDragging
	) {
		document.body.classList.add("drawer-open");
	} else {
		document.body.classList.remove("drawer-open");
	}
});

onMount(() => {
	let disposed = false;

	if (shouldEnableVConsole()) {
		void import("vconsole").then(({ default: VConsole }) => {
			const instance = new VConsole({ theme: "dark" });
			if (disposed) {
				instance.destroy();
				return;
			}
			vConsole = instance;
		});
	}

	void authStore.ensureLoaded().finally(() => {
		authReady = true;
		scheduleCacheCleanup();
		if (authStore.isAuthenticated) turnNotifications.start();
	});

	// Register PWA Service Worker (conservative update: closes all tabs to activate)
	if ("serviceWorker" in navigator) {
		window.addEventListener("load", () => {
			void navigator.serviceWorker.register("/sw.js");
		});
	}

	return () => {
		disposed = true;
		turnNotifications.stop();
		vConsole?.destroy();
		vConsole = null;
		leftSidebarResizeCleanup?.();
		document.body.classList.remove("sidebar-resizing");
	};
});

// Mobile session action sheet was intentionally removed; current item actions live
// on hover for desktop sidebars and in the session/file headers for mobile.
</script>

{#if !authReady}
  <main class="app-shell min-h-screen text-text-primary">
    <CenteredLoading label="Loading…" size="page" />
  </main>
{:else}
  <div class="app-shell h-[100dvh] min-h-0 overflow-hidden flex flex-col lg:flex-row text-text-primary font-sans text-[13px] leading-[1.6]">
    <!-- Desktop sidebar — hidden on mobile -->
    <div class="hidden lg:flex shrink-0 min-h-0 relative" style={`width: ${uiState.leftSidebarCollapsed ? 52 : uiState.leftSidebarWidth}px`}>
      <div class="min-w-0 flex-1 {uiState.leftSidebarCollapsed ? '' : 'border-r border-[color:var(--sidebar-border)]'}">
        <Sidebar mode={sidebarMode} collapsed={uiState.leftSidebarCollapsed} />
      </div>
      {#if !uiState.leftSidebarCollapsed}
        <button
          type="button"
          class="sidebar-resize-handle"
          aria-label="Resize navigation sidebar"
          title="Resize navigation sidebar"
          onpointerdown={beginLeftSidebarResize}
        ></button>
      {/if}
    </div>

    <!-- Main content area -->
    <main class="flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden mobile-drawer-gesture-surface">

      <!-- Page content -->
      <div class="flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden">
        {@render children?.()}
      </div>
    </main>
  </div>

  <!-- Mobile left drawer — outside flex container to avoid stacking context issues -->
  <MobileSidebarDrawer
    dragOffsetPx={dragOffsetPx}
    {isDragging}
    {isDrawerVisible}
    mode={sidebarMode}
  />

  <!-- Global media lightbox -->
  <MediaLightbox />
  <CommandPalette />
  <HelpPanel open={showHelpPanel} onClose={() => { showHelpPanel = false; }} />
  <BillingConversionCenter />
  <TurnNotificationStack />

{/if}

<style>
  .sidebar-resize-handle {
    position: absolute;
    top: 0;
    right: -4px;
    bottom: 0;
    width: 8px;
    border: none;
    padding: 0;
    cursor: col-resize;
    background: transparent;
    touch-action: none;
    z-index: 10;
  }

  .sidebar-resize-handle::after {
    content: "";
    position: absolute;
    top: 0;
    right: 3px;
    width: 2px;
    height: 100%;
    background: transparent;
    transition: background-color 120ms ease;
  }

  .sidebar-resize-handle:hover::after,
  :global(body.sidebar-resizing) .sidebar-resize-handle::after {
    background: var(--border-subtle);
  }
</style>
