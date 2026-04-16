<script lang="ts">
import "../app.css";
import { page } from "$app/state";
import Sidebar from "$lib/components/Sidebar.svelte";
import MobileSidebarDrawer from "$lib/components/MobileSidebarDrawer.svelte";
import {
  MOBILE_DRAWER_WIDTH_PX,
  getDrawerOffsetFromDrag,
  resolveDrawerGestureDirection,
  shouldKeepDrawerOpen,
  shouldOpenDrawer,
  shouldStartDrawerGesture,
  type DrawerGestureDirection,
  type DrawerGesturePhase,
} from "$lib/gestures/drawer-swipe";
import { getResolvedTheme } from "$lib/theme";
import { onMount } from "svelte";
import { LEFT_SIDEBAR_MAX, LEFT_SIDEBAR_MIN, uiState } from "$lib/stores/ui.svelte";
import MediaLightbox from "$lib/components/MediaLightbox.svelte";
import { authStore } from "$lib/stores/auth.svelte";
import { hydrateSpaceStoreFromSidebarCache } from "$lib/stores/cache-hydration";

const { children } = $props();

const currentPath = $derived(page.url.pathname);
const isLogin = $derived(currentPath === "/callback");
const resolvedTheme = $derived(getResolvedTheme());

let gesturePhase = $state<DrawerGesturePhase>("idle");
let gestureDirection = $state<DrawerGestureDirection>(null);
let activeTouchId = $state<number | null>(null);
let pointerStartX = $state(0);
let pointerStartY = $state(0);
let lastPointerX = $state(0);
let lastPointerTime = $state(0);
let dragOffsetPx = $state(0);
let velocityX = $state(0);
let isDragging = $state(false);
let leftSidebarResizeCleanup: (() => void) | null = null;

const isDrawerVisible = $derived(
  isDragging || gesturePhase === "settling" || uiState.mobileDrawerOpen,
);

function resetGestureState() {
  gesturePhase = "idle";
  gestureDirection = null;
  activeTouchId = null;
  pointerStartX = 0;
  pointerStartY = 0;
  lastPointerX = 0;
  lastPointerTime = 0;
  dragOffsetPx = 0;
  velocityX = 0;
  isDragging = false;
}

function beginSettling(open: boolean) {
  gesturePhase = "settling";
  uiState.mobileDrawerOpen = open;
  isDragging = false;
  activeTouchId = null;
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
  if (window.innerWidth >= 1024 || activeTouchId !== null) return;
  const touch = e.changedTouches[0];
  if (!touch) return;

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

  const nextOffsetPx = getDrawerOffsetFromDrag({
    isOpen: uiState.mobileDrawerOpen,
    deltaX: dx,
  });

  if (!uiState.mobileDrawerOpen && nextOffsetPx <= 0) {
    return;
  }
  if (uiState.mobileDrawerOpen && nextOffsetPx >= MOBILE_DRAWER_WIDTH_PX && dx >= 0) {
    return;
  }

  isDragging = true;
  dragOffsetPx = nextOffsetPx;
  gesturePhase = uiState.mobileDrawerOpen ? "dragging-close" : "dragging-open";

  if (e.cancelable) {
    e.preventDefault();
  }
}

function finalizeGesture() {
  if (!isDragging) {
    resetGestureState();
    return;
  }

  const shouldOpen = uiState.mobileDrawerOpen
    ? shouldKeepDrawerOpen({ offsetPx: dragOffsetPx, velocityX })
    : shouldOpenDrawer({ offsetPx: dragOffsetPx, velocityX });

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
  if (window.innerWidth < 1024) return;
  event.preventDefault();

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

// Close drawer on Escape
$effect(() => {
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && uiState.mobileDrawerOpen) {
      uiState.mobileDrawerOpen = false;
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
      if (!uiState.mobileDrawerOpen) {
        dragOffsetPx = 0;
      }
    }
  }, 220);

  return () => window.clearTimeout(timer);
});

// Lock body scroll when drawer is open
$effect(() => {
  if (uiState.mobileDrawerOpen || isDragging) {
    document.body.classList.add("drawer-open");
  } else {
    document.body.classList.remove("drawer-open");
  }
});

onMount(() => {
  uiState.loadLayoutPrefs();
  hydrateSpaceStoreFromSidebarCache();
  void authStore.ensureLoaded();

  // Register PWA Service Worker (conservative update: closes all tabs to activate)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("/sw.js");
    });
  }

  return () => {
    leftSidebarResizeCleanup?.();
    document.body.classList.remove("sidebar-resizing");
  };
});
</script>

{#if isLogin}
  <main class="min-h-screen bg-bg-primary text-text-primary">
    {@render children?.()}
  </main>
{:else}
  <div class="h-screen flex flex-col lg:flex-row bg-bg-primary text-text-primary font-sans text-[13px] leading-[1.6]">
    <!-- Desktop sidebar — hidden on mobile -->
    <div class="hidden lg:flex shrink-0 min-h-0 relative" style={`width: ${uiState.leftSidebarWidth}px`}>
      <div class="min-w-0 flex-1 border-r border-border-subtle">
        <Sidebar />
      </div>
      <button
        type="button"
        class="sidebar-resize-handle"
        aria-label="Resize navigation sidebar"
        title="Resize navigation sidebar"
        onpointerdown={beginLeftSidebarResize}
      ></button>
    </div>

    <!-- Main content area -->
    <main class="flex-1 flex flex-col min-w-0 overflow-hidden mobile-drawer-gesture-surface">

      <!-- Page content -->
      <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
        {@render children?.()}
      </div>
    </main>
  </div>

  <!-- Mobile drawer — outside flex container to avoid stacking context issues -->
  <MobileSidebarDrawer
    dragOffsetPx={dragOffsetPx}
    {isDragging}
    {isDrawerVisible}
  />

  <!-- Global media lightbox -->
  <MediaLightbox />
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

  :global(body.sidebar-resizing) {
    cursor: col-resize;
    user-select: none;
  }
</style>
