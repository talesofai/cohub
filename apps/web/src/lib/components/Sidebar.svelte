<script lang="ts">
import { onMount, untrack } from "svelte";
import { page } from "$app/state";
import { goto } from "$app/navigation";
import {
  FolderKanban,
  Globe,
  Lock,
  Network,
  Plus,
  ChevronRight,
  ChevronDown,
  MessageSquare,
  Loader2,
  Settings,
  LogOut,
  Users,
  Clock,
  Sparkles,
} from "lucide-svelte";
import type {
  SpaceRecord,
  SessionRecord,
} from "$lib/api";
import { logtoClient } from "$lib/auth";
import { unreadTracker, isStreaming } from "$lib/stores/session-state.svelte";
import { sidebarCache } from "$lib/stores/sidebar-cache";
import { authStore } from "$lib/stores/auth.svelte";
import { spaceStore } from "$lib/stores/space-store.svelte";

const { isMobile = false, onClose }: { isMobile?: boolean; onClose?: () => void } = $props();

let expandedSpaces = $state<Set<string>>(new Set());
let isLoading = $state(true);
let loadError = $state("");
let showUserMenu = $state(false);

let streamingSessionIds = $state<Set<string>>(new Set());
let broadcastChannels: BroadcastChannel[] = [];

const spaces = $derived(spaceStore.spaceList);

const currentPath = $derived(page.url.pathname);
const currentSpaceId = $derived.by(() => {
  const match = currentPath.match(/^\/spaces\/([^/]+)/);
  const id = match?.[1] ?? null;
  if (id === "new") return null;
  return id;
});

$effect(() => {
  const id = currentSpaceId;
  untrack(() => {
    if (id && !expandedSpaces.has(id)) {
      expandedSpaces = new Set(expandedSpaces).add(id);
    }
  });
});

function isNavItemActive(href: string) {
  if (href === "/") return currentPath === "/";
  return currentPath.startsWith(href);
}

function isSpaceActive(spaceId: string) {
  return currentSpaceId === spaceId;
}

function isSessionActive(sessionId: string) {
  return page.url.searchParams.get("session") === sessionId;
}

function sourceBadge(source: string | null): string {
  if (!source || source === "web") return "";
  const idx = source.indexOf(":");
  return idx > 0 ? source.slice(0, idx) : source;
}

function sourceTooltip(source: string | null): string {
  return source ?? "";
}

function toggleSpace(spaceId: string) {
  const next = new Set(expandedSpaces);
  if (next.has(spaceId)) next.delete(spaceId);
  else next.add(spaceId);
  expandedSpaces = next;
}

async function loadSpaces(force = false) {
  if (!(await logtoClient.isAuthenticated())) {
    isLoading = false;
    return;
  }

  loadError = "";
  isLoading = spaceStore.spaceList.length === 0;

  try {
    await spaceStore.ensureSpaceList({ force });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load spaces";
    if (message.includes("unauthorized") || message.includes("401")) {
      await logtoClient.signIn(`${window.location.origin}/callback`);
      return;
    }
    loadError = message;
  } finally {
    isLoading = false;
  }
}

async function loadSessions(spaceId: string, force = false) {
  try {
    await Promise.all([
      spaceStore.ensureSpaceSessions(spaceId, { force }),
      authStore.userUuid ? spaceStore.ensureSpacePermissions(spaceId, { force }) : Promise.resolve(),
    ]);
  } catch (error) {
    console.warn("[sidebar] Failed to load sessions", { spaceId, error });
  }
}

function getSessionPerm(session: SessionRecord): string | null {
  return session.shareLevel ?? null;
}

function updateSessionsFromEvent(spaceId: string, sessions: SessionRecord[]) {
  const existing = spaceStore.getSessions(spaceId) ?? [];
  if (
    existing.length === sessions.length &&
    existing.every((session, index) => {
      const incoming = sessions[index];
      return incoming &&
        session.id === incoming.id &&
        session.updatedAt === incoming.updatedAt &&
        session.lastMessageId === incoming.lastMessageId &&
        session.shareLevel === incoming.shareLevel;
    })
  ) {
    return;
  }

  spaceStore.setSessions(spaceId, sessions);
  sidebarCache.setSessions(spaceId, sessions);
  if (sessions.length > 0 && !expandedSpaces.has(spaceId)) {
    expandedSpaces = new Set(expandedSpaces).add(spaceId);
  }
}

function markSessionStreaming(sessionId: string, streaming: boolean) {
  const next = new Set(streamingSessionIds);
  if (streaming) next.add(sessionId);
  else next.delete(sessionId);
  streamingSessionIds = next;
}

function handleStreamingStatusEvent(e: Event) {
  const custom = e as CustomEvent;
  if (custom.detail?.sessionId != null && typeof custom.detail?.isStreaming === "boolean") {
    markSessionStreaming(custom.detail.sessionId, custom.detail.isStreaming);
  }
}

async function handleNavigate(href: string) {
  onClose?.();
  await goto(href);
}

async function handleToggleSpace(spaceId: string, isExpanded: boolean) {
  if (isExpanded) {
    toggleSpace(spaceId);
    return;
  }

  toggleSpace(spaceId);
  void loadSessions(spaceId);

  if (!isMobile) {
    await handleNavigateToSpace(spaceId);
  }
}

async function handleNavigateToSpace(spaceId: string) {
  onClose?.();
  await goto(`/spaces/${spaceId}`);
}

async function handleNavigateToSession(spaceId: string, sessionId: string) {
  onClose?.();
  const session = spaceStore.getSessions(spaceId)?.find((s) => s.id === sessionId);
  if (session?.lastMessageId) unreadTracker.markViewed(sessionId, session.lastMessageId);
  await goto(`/spaces/${spaceId}?session=${sessionId}`);
}

function sessionIsStreaming(session: SessionRecord): boolean {
  return isStreaming(session, streamingSessionIds);
}

function getSessionTitle(session: SessionRecord, _index: number) {
  const candidates = [session.title, session.latestMessageText];
  for (const candidate of candidates) {
    const normalized = candidate?.replace(/\s+/g, " ").replace(/^[:\-\s]+/, "").trim();
    if (normalized) return normalized.slice(0, 36);
  }
  return "New session";
}

async function handleLogout() {
  sidebarCache.invalidateAll();
  onClose?.();
  await logtoClient.signOut(`${window.location.origin}/`);
}

function handleSessionUpdateEvent(e: Event) {
  const custom = e as CustomEvent;
  if (custom.detail?.spaceId && custom.detail?.sessions) {
    updateSessionsFromEvent(custom.detail.spaceId, custom.detail.sessions);
  }
}

onMount(() => {
  void (async () => {
    const authenticated = await logtoClient.isAuthenticated();
    if (authenticated) {
      await authStore.ensureLoaded();
      if (authStore.userUuid) sidebarCache.setUserUuid(authStore.userUuid);
    }

    await loadSpaces();

    if (currentSpaceId) {
      expandedSpaces = new Set(expandedSpaces).add(currentSpaceId);
      void loadSessions(currentSpaceId);
    }

    try {
      const channel = new BroadcastChannel("cohub:sessions-updated");
      channel.onmessage = (e) => {
        if (e.data?.type === "sessions-updated" && e.data?.spaceId && e.data?.sessions) {
          updateSessionsFromEvent(e.data.spaceId, e.data.sessions);
        }
      };
      broadcastChannels.push(channel);
    } catch {}

    window.addEventListener("cohub:sessions-updated", handleSessionUpdateEvent as EventListener);
    window.addEventListener("cohub:streaming-status", handleStreamingStatusEvent as EventListener);

    if (!currentSpaceId && spaces.length > 0) {
      const first = spaces[0];
      expandedSpaces = new Set(expandedSpaces).add(first.id);
      void loadSessions(first.id);
    }
  })();

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-user-menu]')) showUserMenu = false;
  }
  document.addEventListener("click", handleClickOutside);

  return () => {
    document.removeEventListener("click", handleClickOutside);
    window.removeEventListener("cohub:sessions-updated", handleSessionUpdateEvent as EventListener);
    window.removeEventListener("cohub:streaming-status", handleStreamingStatusEvent as EventListener);
    for (const ch of broadcastChannels) ch.close();
    broadcastChannels = [];
  };
});
</script>

<aside class="{isMobile ? 'h-full' : 'shrink-0 h-screen'} flex flex-col bg-bg-primary">
  <div class="h-[48px] flex items-center px-3 border-b border-border-subtle shrink-0">
    <a href="/" class="flex items-center gap-2 group" aria-label="Cohub">
      <div class="w-7 h-7 bg-[#FF3E00] rounded-[6px] flex items-center justify-center font-bold text-[11px] text-white group-hover:bg-brand-hover transition-colors">C</div>
      <span class="font-semibold text-[13px] text-text-primary tracking-tight">Cohub</span>
    </a>
  </div>

  <nav class="px-1.5 py-2 space-y-[2px] shrink-0 border-b border-border-subtle">
    <a href="/explore" class="flex items-center gap-2 px-2 py-[6px] rounded-[5px] text-[13px] transition-colors duration-100 {isNavItemActive('/explore') ? 'bg-bg-active text-text-primary font-medium' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'}" onclick={(e) => { e.preventDefault(); handleNavigate('/explore'); }}>
      <MessageSquare class="w-[15px] h-[15px] shrink-0" />
      <span>Explore</span>
    </a>
    <a href="/workspaces" class="flex items-center gap-2 px-2 py-[6px] rounded-[5px] text-[13px] transition-colors duration-100 {isNavItemActive('/workspaces') ? 'bg-bg-active text-text-primary font-medium' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'}" onclick={(e) => { e.preventDefault(); handleNavigate('/workspaces'); }}>
      <FolderKanban class="w-[15px] h-[15px] shrink-0" />
      <span>Workspaces</span>
    </a>
    <a href="/channels" class="flex items-center gap-2 px-2 py-[6px] rounded-[5px] text-[13px] transition-colors duration-100 {isNavItemActive('/channels') ? 'bg-bg-active text-text-primary font-medium' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'}" onclick={(e) => { e.preventDefault(); handleNavigate('/channels'); }}>
      <Network class="w-[15px] h-[15px] shrink-0" />
      <span>Channels</span>
    </a>
    <a href="/jobs" class="flex items-center gap-2 px-2 py-[6px] rounded-[5px] text-[13px] transition-colors duration-100 {isNavItemActive('/jobs') ? 'bg-bg-active text-text-primary font-medium' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'}" onclick={(e) => { e.preventDefault(); handleNavigate('/jobs'); }}>
      <Clock class="w-[15px] h-[15px] shrink-0" />
      <span>Jobs</span>
    </a>
  </nav>

  <div class="flex flex-col min-h-0 flex-1">
    <div class="h-8 flex items-center justify-between px-2 shrink-0">
      <span class="text-[11px] font-semibold uppercase tracking-[0.1em] text-text-placeholder select-none">Spaces</span>
      <button type="button" class="flex items-center justify-center w-5 h-5 rounded-sm text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors duration-100 cursor-pointer" onclick={() => handleNavigate('/spaces/new')} title="Create space">
        <Plus class="w-3.5 h-3.5" />
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-1.5 pb-2 space-y-[2px]">
      {#if isLoading}
        <div class="px-3 py-4 text-[12px] text-text-tertiary text-center flex items-center justify-center gap-2">
          <Loader2 class="w-3 h-3 animate-spin" />
          Loading...
        </div>
      {:else if loadError}
        <div class="px-3 py-3 text-[12px] text-error-soft text-center">{loadError}</div>
      {:else if spaces.length === 0}
        <div class="px-3 py-4 text-[12px] text-text-tertiary text-center">No spaces</div>
      {:else}
        {#each spaces as space (space.id)}
          {@const isExpanded = expandedSpaces.has(space.id)}
          {@const isActive = isSpaceActive(space.id)}
          {@const sessions = spaceStore.getSessions(space.id) ?? []}

          <div>
            <div role="button" tabindex="0" class="group relative flex items-center gap-1.5 pl-[6px] pr-2 py-1.5 rounded-r-[5px] cursor-pointer transition-colors duration-100 {isActive ? 'text-text-primary font-medium' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'}" onclick={() => { void handleToggleSpace(space.id, isExpanded); }} onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void handleToggleSpace(space.id, isExpanded);
              }
            }}>
              <span class="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full {isActive ? 'bg-brand' : 'bg-brand/40'}"></span>
              <span class="flex items-center justify-center w-4 h-4 shrink-0 text-text-tertiary group-hover:text-text-secondary transition-colors">
                {#if isExpanded}
                  <ChevronDown class="w-3 h-3" />
                {:else}
                  <ChevronRight class="w-3 h-3" />
                {/if}
              </span>
              <span class="truncate flex-1 text-[13.5px] leading-tight">{space.name || space.id.slice(0, 12)}</span>
              {#if space.userUuid !== authStore.userUuid}
                <Users class="w-3 h-3 shrink-0 text-text-tertiary" />
              {/if}
            </div>

            {#if isExpanded}
              <div class="ml-[14px] pl-2.5 border-l border-border-subtle space-y-0.5 py-0.5">
                {#if sessions.length === 0}
                  <div class="px-2 py-1 text-[12px] text-text-placeholder italic">No sessions</div>
                {:else}
                  {#each sessions as session, index (session.id)}
                    <a href="/spaces/{space.id}?session={session.id}" class="flex items-center gap-1.5 px-2 py-1 rounded-[4px] text-[12.5px] transition-colors duration-100 {isSessionActive(session.id) ? 'text-text-primary bg-bg-active font-medium' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'}" onclick={(e) => { e.preventDefault(); handleNavigateToSession(space.id, session.id); }} title={sourceTooltip(session.source) || undefined}>
                      <span class="truncate leading-tight flex-1">{getSessionTitle(session, index)}</span>
                      {#if space.userUuid === authStore.userUuid}
                        {@const perm = getSessionPerm(session)}
                        {#if perm === "read" || perm === "write"}
                          <Globe class="w-3 h-3 shrink-0 text-text-placeholder" />
                        {:else if perm === "private"}
                          <Lock class="w-3 h-3 shrink-0 text-text-placeholder" />
                        {/if}
                      {/if}
                      {#if sourceBadge(session.source)}
                        <span class="shrink-0 px-1.5 py-px rounded-[3px] bg-bg-hover-strong text-[10px] font-medium leading-none text-text-tertiary">{sourceBadge(session.source)}</span>
                      {/if}
                      {#if sessionIsStreaming(session)}
                        <div class="w-[6px] h-[6px] rounded-full shrink-0 bg-status-running animate-pulse" title="Streaming..."></div>
                      {:else if unreadTracker.isUnread(session)}
                        <div class="w-[7px] h-[7px] rounded-full shrink-0 bg-brand" title="Unread"></div>
                      {/if}
                    </a>
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </div>

  <div class="border-t border-border-subtle p-1.5 shrink-0 relative">
    {#if showUserMenu}
      <div data-user-menu class="absolute bottom-full left-1.5 right-1.5 mb-1 bg-bg-primary border border-border-subtle rounded-md shadow-lg overflow-hidden z-50">
        <a href="/settings" class="flex items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100" onclick={(e) => { e.preventDefault(); showUserMenu = false; handleNavigate('/settings'); }}>
          <Settings class="w-3.5 h-3.5" />
          <span>Settings</span>
        </a>
        <button class="flex items-center gap-2 w-full px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-error-soft hover:bg-bg-hover transition-colors duration-100" onclick={() => { showUserMenu = false; void handleLogout(); }}>
          <LogOut class="w-3.5 h-3.5" />
          <span>Sign out</span>
        </button>
      </div>
    {/if}

    <button type="button" data-user-menu class="flex items-center gap-2 w-full px-2 py-[6px] rounded-[5px] hover:bg-bg-hover transition-colors duration-100 cursor-pointer" onclick={() => { showUserMenu = !showUserMenu; }}>
      <div class="w-[22px] h-[22px] rounded-full bg-bg-hover-strong overflow-hidden shrink-0">
        {#if authStore.claims?.picture}
          <img src={authStore.claims.picture} alt="avatar" class="w-full h-full object-cover" />
        {:else}
          <svg viewBox="0 0 32 32" class="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="16" fill="#e5e7eb" />
            <circle cx="16" cy="12" r="5" fill="#9ca3af" />
            <ellipse cx="16" cy="26" rx="9" ry="7" fill="#9ca3af" />
          </svg>
        {/if}
      </div>
      <div class="flex-1 min-w-0 text-left">
        <p class="text-[12px] text-text-secondary truncate">{authStore.claims?.name ?? 'Guest'}</p>
      </div>
      <ChevronDown class="w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-150 {showUserMenu ? 'rotate-180' : ''}" />
    </button>
  </div>
</aside>
