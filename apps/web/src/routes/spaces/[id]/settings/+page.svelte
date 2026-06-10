<script lang="ts">
import type {
	Channel,
	SpaceAccessPolicy,
	SpaceChannelBindingRecord,
	SpaceEnvInput,
	SpaceInvitation,
	SpaceMember,
	SpaceModListItem,
	SpaceRecord,
	SpaceRole,
	SpaceSandboxAutoDestroyPolicy,
	VoiceLexiconEntry,
} from "@neta-art/cohub";
import {
	ArrowLeft,
	Check,
	Copy,
	Eye,
	Globe,
	Link,
	Loader2,
	Mic,
	Network,
	PackagePlus,
	Pencil,
	Plus,
	RefreshCw,
	Settings,
	Terminal,
	Trash2,
	Users,
	X,
} from "lucide-svelte";
import { onDestroy } from "svelte";
import { goto } from "$app/navigation";
import VoiceLexiconEditor from "$lib/components/VoiceLexiconEditor.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { sdk } from "$lib/sdk";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import { setCachedSpaceVoiceInputLexicon } from "$lib/voice-input-lexicon";

type SandboxInfo = {
	status: string | null;
	runtimeStatus?: string | null;
	podName?: string | null;
	desiredImage?: string | null;
	reportedImageVersion?: string | null;
	lastHeartbeatAt?: string | null;
	lastActivityAt?: string | null;
	reportedAt?: string | null;
	stoppedAt?: string | null;
	stopReason?: string | null;
	meta?: Record<string, unknown> | null;
};

const props = $props<{ data: { spaceId: string } }>();
const spaceId = $derived(props.data.spaceId);
const defaultIdleTtlSeconds = import.meta.env.DEV ? 10 * 60 : 12 * 60 * 60;

let space = $state<SpaceRecord | null>(null);
let access = $state<SpaceAccessPolicy | null>(null);
let members = $state<SpaceMember[]>([]);
let invitations = $state<SpaceInvitation[]>([]);
let env = $state<SpaceEnvInput[]>([]);
let channels = $state<SpaceChannelBindingRecord[]>([]);
let mods = $state<SpaceModListItem[]>([]);
let sandbox = $state<SandboxInfo | null>(null);
let allChannels = $state<Channel[]>([]);
let loading = $state(true);
let error = $state("");
let envName = $state("");
let envValue = $state("");
let selectedChannelId = $state("");
let modSpaceId = $state("");
let modName = $state("");
let modMountSlug = $state("");
let modError = $state("");
let modSaving = $state(false);
let modUpdatingId = $state<string | null>(null);
let modRestartMessage = $state("");
let modRestartTimer: ReturnType<typeof setTimeout> | null = null;
let revealedEnvNames = $state<Set<string>>(new Set());
let copiedMemberUserId = $state<string | null>(null);
let copiedMemberTimer: ReturnType<typeof setTimeout> | null = null;
let addingMemberUuid = $state("");
let addingMemberRole = $state<SpaceRole>("guest");
let savingMember = $state(false);
let addingMemberError = $state("");
let updatingMemberUserId = $state<string | null>(null);
let removingMemberUserId = $state<string | null>(null);
let loadingInvitations = $state(false);
let invitationsError = $state("");
let showInvitePanel = $state(false);
let inviteRole = $state<SpaceRole>("builder");
let inviteTtlDays = $state(7);
let inviteMaxUses = $state(0);
let creatingInvite = $state(false);
let inviteCreateError = $state("");
let inviteCreateNotice = $state("");
let inviteNoticeTimer: ReturnType<typeof setTimeout> | null = null;
let copiedInviteToken = $state<string | null>(null);
let copiedInviteTimer: ReturnType<typeof setTimeout> | null = null;
let recoveringSandbox = $state(false);
let sandboxRecoveryMessage = $state("");
let sandboxRecoveryError = $state("");
let sandboxAutoDestroyMode = $state<"idle" | "never">("idle");
let sandboxIdleTtlSeconds = $state(defaultIdleTtlSeconds);
let savingSandboxConfig = $state(false);
let sandboxConfigMessage = $state("");
let sandboxConfigError = $state("");
let voiceLexiconEntries = $state<VoiceLexiconEntry[]>([]);
let voiceLexiconLoading = $state(false);
let voiceLexiconError = $state("");

const canManageVoiceLexicon = $derived(
	Boolean(space?.access?.permissions?.includes("space.edit")),
);

onDestroy(() => {
	if (inviteNoticeTimer) clearTimeout(inviteNoticeTimer);
	if (copiedInviteTimer) clearTimeout(copiedInviteTimer);
	if (modRestartTimer) clearTimeout(modRestartTimer);
	if (copiedMemberTimer) clearTimeout(copiedMemberTimer);
});

function getSpaceAutoDestroyPolicy(
	record: SpaceRecord | null,
): SpaceSandboxAutoDestroyPolicy {
	const fallback = { mode: "idle" as const, ttlSeconds: defaultIdleTtlSeconds };
	const policy = record?.meta?.config?.sandbox?.autoDestroy;
	if (!policy) return fallback;
	if (policy.mode === "never") return { mode: "never" };
	if (policy.mode === "idle" && Number.isInteger(policy.ttlSeconds))
		return policy;
	return fallback;
}

function applySandboxConfigFromSpace(record: SpaceRecord | null) {
	const policy = getSpaceAutoDestroyPolicy(record);
	sandboxAutoDestroyMode = policy.mode;
	sandboxIdleTtlSeconds =
		policy.mode === "idle" ? policy.ttlSeconds : defaultIdleTtlSeconds;
}

function formatTtl(seconds: number): string {
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

async function saveSandboxConfig() {
	savingSandboxConfig = true;
	sandboxConfigMessage = "";
	sandboxConfigError = "";
	try {
		const autoDestroy: SpaceSandboxAutoDestroyPolicy =
			sandboxAutoDestroyMode === "never"
				? { mode: "never" }
				: { mode: "idle", ttlSeconds: Number(sandboxIdleTtlSeconds) };
		const result = await sdk
			.space(spaceId)
			.updateConfig({ sandbox: { autoDestroy } });
		space = result.space;
		cacheSpaceRecordSoon(result.space);
		applySandboxConfigFromSpace(result.space);
		sandboxConfigMessage = "Sandbox auto-destroy policy saved.";
	} catch (err) {
		sandboxConfigError =
			err instanceof Error ? err.message : "Failed to save sandbox config";
	} finally {
		savingSandboxConfig = false;
	}
}

function getSandboxMetaValue(key: string): string {
	const meta = sandbox?.meta;
	if (!meta || typeof meta !== "object") return "";
	const value = meta[key];
	return typeof value === "string" ? value : "";
}

function formatTime(value?: string | null): string {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString();
}

function formatRelativeTime(value?: string | null): string {
	if (!value) return "—";
	const date = new Date(value);
	const time = date.getTime();
	if (Number.isNaN(time)) return "—";
	const diffMs = Date.now() - time;
	const absMs = Math.abs(diffMs);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	const suffix = diffMs >= 0 ? "ago" : "from now";
	if (absMs < minute) return "just now";
	if (absMs < hour) return `${Math.round(absMs / minute)}m ${suffix}`;
	if (absMs < day) return `${Math.round(absMs / hour)}h ${suffix}`;
	return `${Math.round(absMs / day)}d ${suffix}`;
}

function getSandboxLifecycleLabel(status?: string | null): string {
	switch (status) {
		case "running":
		case "ready":
			return "Running";
		case "provisioning":
		case "pending":
			return "Provisioning";
		case "stopping":
			return "Stopping";
		case "stopped":
			return "Stopped";
		case "error":
			return "Error";
		case "terminated":
			return "Terminated";
		default:
			return "Unknown";
	}
}

function getSandboxRuntimeLabel(status?: string | null): string {
	switch (status) {
		case "healthy":
			return "Healthy";
		case "starting":
			return "Starting";
		case "degraded":
			return "Degraded";
		case "unhealthy":
			return "Unhealthy";
		default:
			return "Unknown";
	}
}

function getSandboxStatusClass(status?: string | null): string {
	if (status === "running" || status === "ready" || status === "healthy")
		return "bg-success-bg text-success-soft ring-success-soft/20";
	if (
		status === "provisioning" ||
		status === "pending" ||
		status === "starting" ||
		status === "stopping"
	)
		return "bg-brand-bg text-brand-muted-fg ring-brand/20";
	if (status === "stopped" || status === "unknown")
		return "bg-bg-hover text-text-tertiary ring-border-subtle";
	return "bg-error-bg text-error-soft ring-error-soft/25";
}

function getSandboxActivityText(): string {
	const activity = formatRelativeTime(sandbox?.lastActivityAt);
	if (activity !== "—") return activity;
	return formatRelativeTime(sandbox?.lastHeartbeatAt);
}

function getSandboxActivityLabel(): string {
	return sandbox?.lastActivityAt ? "Last RPC activity" : "No RPC activity yet";
}

function getSandboxActivityTitle(): string {
	const label = getSandboxActivityLabel();
	const activityTime = formatTime(sandbox?.lastActivityAt);
	const heartbeatTime = formatTime(sandbox?.lastHeartbeatAt);
	return `${label}\nLast RPC activity: ${activityTime}\nHeartbeat: ${heartbeatTime}\nIdle hibernation is driven by sandbox RPC / tool calls.`;
}

function getSandboxHeartbeatTitle(): string {
	return `Sandbox self-report\nLast heartbeat: ${formatTime(sandbox?.lastHeartbeatAt)}\nHeartbeat only means the sandbox runtime recently reported itself alive.`;
}

async function loadSandbox() {
	const result = await sdk
		.space(spaceId)
		.sandbox.get()
		.catch(() => null);
	sandbox = result?.sandbox ?? null;
}

function confirmModRestart(): boolean {
	return window.confirm(
		"Changing Space Mods will restart the Sandbox and may interrupt running commands or agent turns. Continue?",
	);
}

function noteModRestart() {
	modRestartMessage =
		"Sandbox restart queued. Mods will be mounted when it comes back online.";
	if (modRestartTimer) clearTimeout(modRestartTimer);
	modRestartTimer = setTimeout(() => {
		modRestartMessage = "";
	}, 6000);
}

async function loadMods() {
	const result = await sdk.space(spaceId).mods.list();
	mods = result.items;
}

function cacheSpaceVoiceLexicon(items: VoiceLexiconEntry[]) {
	voiceLexiconEntries = items;
	setCachedSpaceVoiceInputLexicon(spaceId, items);
}

async function loadSpaceVoiceLexicon() {
	voiceLexiconLoading = true;
	voiceLexiconError = "";
	try {
		const result = await sdk.space(spaceId).voiceLexicon.list();
		cacheSpaceVoiceLexicon(result.items);
	} catch (err) {
		voiceLexiconError =
			err instanceof Error ? err.message : "Failed to load voice terms";
	} finally {
		voiceLexiconLoading = false;
	}
}

async function addSpaceVoiceLexiconTerm(term: string) {
	const result = await sdk.space(spaceId).voiceLexicon.add({
		term,
		source: "manual",
	});
	cacheSpaceVoiceLexicon([
		result.item,
		...voiceLexiconEntries.filter((entry) => entry.id !== result.item.id),
	]);
}

async function updateSpaceVoiceLexiconTerm(
	entry: VoiceLexiconEntry,
	term: string,
) {
	const result = await sdk.space(spaceId).voiceLexicon.update(entry.id, {
		term,
		source: entry.source,
		originalText: entry.originalText,
	});
	cacheSpaceVoiceLexicon(
		voiceLexiconEntries.map((item) =>
			item.id === entry.id ? result.item : item,
		),
	);
}

async function deleteSpaceVoiceLexiconTerm(entry: VoiceLexiconEntry) {
	await sdk.space(spaceId).voiceLexicon.delete(entry.id);
	cacheSpaceVoiceLexicon(
		voiceLexiconEntries.filter((item) => item.id !== entry.id),
	);
}

async function forceRecoverSandbox() {
	if (recoveringSandbox) return;
	const confirmed = window.confirm(
		"Force recovery will recreate the Sandbox and stop any running processes. Workspace files will be preserved. Continue?",
	);
	if (!confirmed) return;
	recoveringSandbox = true;
	sandboxRecoveryMessage = "";
	sandboxRecoveryError = "";
	try {
		const result = await sdk.space(spaceId).sandbox.recreate();
		sandboxRecoveryMessage = result.verified
			? "Sandbox recovered and verified."
			: "Sandbox recovery completed.";
		await loadSandbox();
	} catch (err) {
		sandboxRecoveryError =
			err instanceof Error ? err.message : "Sandbox recovery failed";
	} finally {
		recoveringSandbox = false;
	}
}

async function loadPage() {
	loading = true;
	error = "";
	try {
		const [
			spaceResult,
			accessResult,
			memberResult,
			envResult,
			channelResult,
			modResult,
			allChannelResult,
			sandboxResult,
			invitationResult,
			voiceLexiconResult,
		] = await Promise.all([
			sdk.space(spaceId).get(),
			sdk
				.space(spaceId)
				.access.get()
				.catch(() => null),
			sdk
				.space(spaceId)
				.members.list()
				.catch(() => ({ items: [] })),
			sdk
				.space(spaceId)
				.env.list()
				.catch(() => ({ env: [] })),
			sdk
				.space(spaceId)
				.channels.list()
				.catch(() => []),
			sdk
				.space(spaceId)
				.mods.list()
				.catch(() => ({ items: [] })),
			sdk.channels.list().catch(() => []),
			sdk
				.space(spaceId)
				.sandbox.get()
				.catch(() => null),
			sdk
				.space(spaceId)
				.invitations.list()
				.catch(() => ({ items: [] })),
			sdk
				.space(spaceId)
				.voiceLexicon.list()
				.catch(() => ({ items: [] })),
		]);
		space = spaceResult;
		cacheSpaceRecordSoon(spaceResult);
		access = accessResult;
		members = memberResult.items;
		env = envResult.env;
		channels = channelResult;
		mods = modResult.items;
		allChannels = allChannelResult;
		sandbox = sandboxResult?.sandbox ?? null;
		invitations = invitationResult.items;
		cacheSpaceVoiceLexicon(voiceLexiconResult.items);
		applySandboxConfigFromSpace(spaceResult);
	} catch (err) {
		error = err instanceof Error ? err.message : "Failed to load settings";
	} finally {
		loading = false;
	}
}

async function setAccess(body: {
	signed_in_user?: SpaceRole | null;
	anonymous_user?: SpaceRole | null;
}) {
	access = await sdk.space(spaceId).access.set(body);
}

async function addEnv() {
	if (!envName.trim()) return;
	const result = await sdk
		.space(spaceId)
		.env.create({ name: envName.trim(), value: envValue });
	env = result.env;
	envName = "";
	envValue = "";
}

async function removeEnv(name: string) {
	const result = await sdk.space(spaceId).env.remove(name);
	env = result.env;
}

function toggleEnvReveal(name: string) {
	const next = new Set(revealedEnvNames);
	if (next.has(name)) next.delete(name);
	else next.add(name);
	revealedEnvNames = next;
}

function formatInviteExpiry(seconds: number | null): string {
	if (seconds === null) return "No expiry";
	if (seconds < 60) return "Expires in <1m";
	if (seconds < 3600) return `Expires in ${Math.ceil(seconds / 60)}m`;
	if (seconds < 86400) return `Expires in ${Math.ceil(seconds / 3600)}h`;
	return `Expires in ${Math.ceil(seconds / 86400)}d`;
}

async function loadMembers() {
	const result = await sdk.space(spaceId).members.list();
	members = result.items;
}

async function addMember() {
	if (!addingMemberUuid.trim() || savingMember) return;
	savingMember = true;
	addingMemberError = "";
	try {
		await sdk
			.space(spaceId)
			.members.update(addingMemberUuid.trim(), addingMemberRole);
		addingMemberUuid = "";
		await loadMembers();
	} catch (err) {
		addingMemberError =
			err instanceof Error ? err.message : "Failed to add member";
	} finally {
		savingMember = false;
	}
}

function getMemberDisplayName(member: SpaceMember): string {
	return member.profile?.displayName?.trim() || "User";
}

function getInitials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const initials = words
		.slice(0, 2)
		.map((word) => word[0]?.toUpperCase() ?? "")
		.join("");
	return initials || "U";
}

function getMemberRoleIcon(role: SpaceRole) {
	if (role === "host") return "👑";
	return null;
}

function getMemberUuid(member: SpaceMember): string {
	return member.profile?.userUuid ?? member.userId;
}

async function copyMemberUuid(member: SpaceMember) {
	const value = getMemberUuid(member);
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(value);
		} else {
			const textarea = document.createElement("textarea");
			textarea.value = value;
			textarea.setAttribute("readonly", "true");
			textarea.style.position = "fixed";
			textarea.style.opacity = "0";
			document.body.appendChild(textarea);
			textarea.select();
			const copied = document.execCommand("copy");
			document.body.removeChild(textarea);
			if (!copied) return;
		}
		copiedMemberUserId = member.userId;
		if (copiedMemberTimer) clearTimeout(copiedMemberTimer);
		copiedMemberTimer = setTimeout(() => {
			copiedMemberUserId = null;
		}, 2000);
	} catch {
		// ignore copy failure silently
	}
}

async function updateMemberRole(userId: string, role: SpaceRole) {
	updatingMemberUserId = userId;
	addingMemberError = "";
	try {
		await sdk.space(spaceId).members.update(userId, role);
		await loadMembers();
	} catch (err) {
		addingMemberError =
			err instanceof Error ? err.message : "Failed to update member";
	} finally {
		updatingMemberUserId = null;
	}
}

async function removeMember(userId: string) {
	if (!window.confirm("Remove this member from the space?")) return;
	removingMemberUserId = userId;
	addingMemberError = "";
	try {
		await sdk.space(spaceId).members.remove(userId);
		await loadMembers();
	} catch (err) {
		addingMemberError =
			err instanceof Error ? err.message : "Failed to remove member";
	} finally {
		removingMemberUserId = null;
	}
}

async function loadInvitations() {
	loadingInvitations = true;
	invitationsError = "";
	try {
		const result = await sdk.space(spaceId).invitations.list();
		invitations = result.items;
	} catch (err) {
		invitationsError =
			err instanceof Error ? err.message : "Failed to load invitations";
	} finally {
		loadingInvitations = false;
	}
}

async function createInvite() {
	if (creatingInvite) return;
	if (inviteMaxUses < 0 || inviteMaxUses > 10000) {
		inviteCreateError = "Max uses must be between 0 and 10000";
		return;
	}
	creatingInvite = true;
	inviteCreateError = "";
	inviteCreateNotice = "";
	try {
		const created = await sdk.space(spaceId).invitations.create({
			role: inviteRole,
			ttlSeconds: inviteTtlDays * 24 * 60 * 60,
			maxUses: inviteMaxUses || undefined,
		});
		const copied = await copyInviteLink(created.token);
		inviteCreateNotice = copied
			? "Invite link created and copied to clipboard."
			: "Invite link created. Copying failed, please copy it manually.";
		if (inviteNoticeTimer) clearTimeout(inviteNoticeTimer);
		inviteNoticeTimer = setTimeout(() => {
			inviteCreateNotice = "";
		}, 4000);
		showInvitePanel = false;
		await loadInvitations();
	} catch (err) {
		inviteCreateError =
			err instanceof Error ? err.message : "Failed to create invitation";
	} finally {
		creatingInvite = false;
	}
}

async function copyInviteLink(token: string) {
	const url = `${window.location.origin}/invite/${token}`;
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(url);
		} else {
			const textarea = document.createElement("textarea");
			textarea.value = url;
			textarea.setAttribute("readonly", "true");
			textarea.style.position = "fixed";
			textarea.style.opacity = "0";
			document.body.appendChild(textarea);
			textarea.select();
			const copied = document.execCommand("copy");
			document.body.removeChild(textarea);
			if (!copied) return false;
		}
		copiedInviteToken = token;
		if (copiedInviteTimer) clearTimeout(copiedInviteTimer);
		copiedInviteTimer = setTimeout(() => {
			copiedInviteToken = null;
		}, 2000);
		return true;
	} catch {
		return false;
	}
}

async function revokeInvite(token: string) {
	if (!window.confirm("Revoke this invitation link? It will no longer work."))
		return;
	invitationsError = "";
	try {
		await sdk.space(spaceId).invitations.revoke(token);
		await loadInvitations();
	} catch (err) {
		invitationsError =
			err instanceof Error ? err.message : "Failed to revoke invitation";
	}
}

async function bindChannel() {
	if (!selectedChannelId) return;
	await sdk.space(spaceId).channels.bind(selectedChannelId);
	channels = await sdk.space(spaceId).channels.list();
	selectedChannelId = "";
}

async function unbindChannel(channelId: string) {
	await sdk.space(spaceId).channels.unbind(channelId);
	channels = await sdk.space(spaceId).channels.list();
}

async function addMod() {
	const target = modSpaceId.trim();
	if (!target || modSaving) return;
	if (!confirmModRestart()) return;
	modSaving = true;
	modError = "";
	try {
		const result = await sdk.space(spaceId).mods.create({
			modSpaceId: target,
			name: modName.trim() || null,
			mountSlug: modMountSlug.trim() || null,
		});
		mods = result.item
			? [...mods, result.item].sort((a, b) => a.sortOrder - b.sortOrder)
			: (await sdk.space(spaceId).mods.list()).items;
		modSpaceId = "";
		modName = "";
		modMountSlug = "";
		noteModRestart();
		await loadSandbox();
	} catch (err) {
		modError = err instanceof Error ? err.message : "Failed to add mod";
	} finally {
		modSaving = false;
	}
}

async function toggleMod(mod: SpaceModListItem) {
	if (!confirmModRestart()) return;
	modUpdatingId = mod.id;
	modError = "";
	try {
		const result = await sdk
			.space(spaceId)
			.mods.update(mod.id, { enabled: !mod.enabled });
		mods = mods.map((item) => (item.id === mod.id ? result.item : item));
		noteModRestart();
		await loadSandbox();
	} catch (err) {
		modError = err instanceof Error ? err.message : "Failed to update mod";
	} finally {
		modUpdatingId = null;
	}
}

async function updateModMountSlug(mod: SpaceModListItem, mountSlug: string) {
	if (!confirmModRestart()) return;
	modUpdatingId = mod.id;
	modError = "";
	try {
		const result = await sdk
			.space(spaceId)
			.mods.update(mod.id, { mountSlug: mountSlug || undefined });
		mods = mods.map((item) => (item.id === mod.id ? result.item : item));
		noteModRestart();
		await loadSandbox();
	} catch (err) {
		modError = err instanceof Error ? err.message : "Failed to update mod";
	} finally {
		modUpdatingId = null;
	}
}

async function removeMod(mod: SpaceModListItem) {
	if (!confirmModRestart()) return;
	modUpdatingId = mod.id;
	modError = "";
	try {
		await sdk.space(spaceId).mods.remove(mod.id);
		mods = mods.filter((item) => item.id !== mod.id);
		noteModRestart();
		await loadSandbox();
	} catch (err) {
		modError = err instanceof Error ? err.message : "Failed to remove mod";
	} finally {
		modUpdatingId = null;
	}
}

$effect(() => {
	void loadPage();
});
</script>

<svelte:head><title>Space settings — Cohub</title></svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
	<header class="flex h-[44px] shrink-0 items-center justify-between border-b border-border-subtle bg-bg-primary px-3 sm:px-4">
		<div class="flex min-w-0 items-center gap-3">
			<button
				type="button"
				class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus:ring-1 focus:ring-brand/40"
				aria-label="Back to space"
				onclick={() => goto(`/spaces/${spaceId}`)}
			>
				<ArrowLeft class="h-4 w-4" />
			</button>
			<div class="min-w-0">
				<div class="truncate text-[13px] font-medium text-text-primary">Space settings</div>
			</div>
		</div>
	</header>

	<main class="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 sm:py-6">
		<div class="mx-auto w-full max-w-4xl space-y-4 sm:space-y-5">
			{#if loading}
				<div class="flex items-center gap-2 rounded-[8px] border border-border-subtle bg-bg-surface px-4 py-3 text-[13px] text-text-tertiary">
					<Loader2 class="h-4 w-4 animate-spin" /> Loading settings…
				</div>
			{:else if error}
				<div class="rounded-[8px] border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">{error}</div>
			{:else}
				<section class="overflow-hidden rounded-[10px] border border-border-subtle bg-bg-surface">
					<div class="flex flex-col gap-3 border-b border-border-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
						<div class="flex min-w-0 items-center gap-2.5">
							<Users class="h-4 w-4 text-text-tertiary" />
							<div class="min-w-0">
								<div class="text-[15px] font-medium text-text-primary">Access</div>
								<div class="text-[12px] text-text-tertiary">Members, permissions, invites.</div>
							</div>
						</div>
						<button type="button" onclick={() => { showInvitePanel = true; inviteCreateError = ""; }} class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] border border-brand/20 bg-brand-bg px-3 py-2 text-[12px] font-medium text-brand-muted-fg transition-colors hover:bg-brand-muted"><Link class="h-3.5 w-3.5" /> Invite</button>
					</div>
					<div class="space-y-5 p-4 sm:p-5">
						<div class="grid gap-3 sm:grid-cols-2">
							<label class="block rounded-[8px] border border-border-subtle bg-bg-primary p-3">
								<span class="text-[12px] font-medium text-text-secondary">Signed-in users</span>
								<select value={access?.signed_in_user ?? ""} onchange={(e) => { const value = (e.currentTarget as HTMLSelectElement).value as SpaceRole | ""; void setAccess({ signed_in_user: value || null }); }} class="mt-2 w-full rounded-[6px] border border-border-subtle bg-bg-input px-2.5 py-2 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none"><option value="">None</option><option value="guest">Guest</option><option value="builder">Builder</option></select>
							</label>
							<label class="block rounded-[8px] border border-border-subtle bg-bg-primary p-3">
								<span class="text-[12px] font-medium text-text-secondary">Anonymous</span>
								<select value={access?.anonymous_user ?? ""} onchange={(e) => { const value = (e.currentTarget as HTMLSelectElement).value as SpaceRole | ""; void setAccess({ anonymous_user: value || null }); }} class="mt-2 w-full rounded-[6px] border border-border-subtle bg-bg-input px-2.5 py-2 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none"><option value="">None</option><option value="guest">Guest</option></select>
							</label>
						</div>

						<div class="space-y-3">
							<div class="flex items-center justify-between gap-3">
								<div class="text-[12px] font-medium text-text-secondary">Members · {members.length}</div>
							</div>
							<div class="flex flex-col gap-2 sm:flex-row">
								<input type="text" bind:value={addingMemberUuid} placeholder="Paste user UUID" onkeydown={(event) => { if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) { event.preventDefault(); void addMember(); } }} class="min-h-9 min-w-0 flex-1 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
								<div class="grid grid-cols-[1fr_auto] gap-2 sm:flex">
									<select bind:value={addingMemberRole} class="min-h-9 rounded-[6px] border border-border-subtle bg-bg-input px-2.5 py-2 text-[12px] text-text-secondary focus:border-brand/40 focus:outline-none"><option value="guest">Guest</option><option value="builder">Builder</option><option value="host">Host</option></select>
									<button type="button" onclick={() => { void addMember(); }} disabled={savingMember || !addingMemberUuid.trim()} class="inline-flex min-h-9 min-w-20 items-center justify-center gap-1.5 rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50">{#if savingMember}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if} Add</button>
								</div>
							</div>
							{#if addingMemberError}<div class="rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft break-words">{addingMemberError}</div>{/if}

							<div class="space-y-1.5">
								{#each members as member (member.userId)}
									<div class="group grid grid-cols-[auto_1fr] gap-2 rounded-[7px] bg-bg-primary px-3 py-2 sm:flex sm:items-center">
										<div class="flex items-center gap-2">
											{#if getMemberRoleIcon(member.role)}<span class="w-3.5 text-center text-[12px]">{getMemberRoleIcon(member.role)}</span>{:else if member.role === 'builder'}<Pencil class="h-3.5 w-3.5 shrink-0 text-brand" />{:else}<Eye class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />{/if}
											<div class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border-subtle bg-bg-hover-strong text-[10px] font-semibold text-text-tertiary">
												{#if member.profile?.avatarUrl}<img src={member.profile.avatarUrl} alt="" class="h-full w-full object-cover" />{:else}{getInitials(getMemberDisplayName(member))}{/if}
											</div>
										</div>
										<div class="min-w-0">
											<div class="truncate text-[12px] font-medium text-text-secondary">{getMemberDisplayName(member)}</div>
											<button type="button" onclick={() => { void copyMemberUuid(member); }} title="Click to copy user UUID" class="mt-0.5 inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-left font-mono text-[10px] text-text-placeholder transition-colors hover:bg-bg-hover/60 hover:text-text-secondary"><span class="min-w-0 truncate">{getMemberUuid(member)}</span>{#if copiedMemberUserId === member.userId}<Check class="h-3 w-3 shrink-0 text-success-soft" />{/if}</button>
										</div>
										<div class="col-span-2 flex items-center justify-end gap-1 sm:ml-auto sm:shrink-0">
											<select value={member.role} disabled={updatingMemberUserId === member.userId || removingMemberUserId === member.userId} onchange={(event) => { const role = (event.currentTarget as HTMLSelectElement).value as SpaceRole; void updateMemberRole(member.userId, role); }} class="rounded-[5px] bg-transparent px-2 py-1 text-[10px] uppercase tracking-wider text-text-placeholder hover:bg-bg-hover focus:bg-bg-input focus:outline-none disabled:opacity-50"><option value="guest">Guest</option><option value="builder">Builder</option><option value="host">Host</option></select>
											<button type="button" onclick={() => { void removeMember(member.userId); }} disabled={removingMemberUserId === member.userId} title="Remove member" class="inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-error-soft disabled:opacity-50">{#if removingMemberUserId === member.userId}<Loader2 class="h-3 w-3 animate-spin" />{:else}<X class="h-3.5 w-3.5" />{/if}</button>
										</div>
									</div>
								{:else}
									<div class="rounded-[7px] bg-bg-primary px-3 py-2 text-[12px] text-text-tertiary">No members.</div>
								{/each}
							</div>
						</div>

						<div class="border-t border-border-subtle pt-4">
							<div class="mb-2 flex items-center justify-between gap-2">
								<div class="flex items-center gap-2 text-[12px] font-medium text-text-secondary"><Link class="h-3.5 w-3.5 text-text-tertiary" /> Invite links</div>
								<div class="flex items-center gap-2"><button type="button" onclick={() => { void loadInvitations(); }} disabled={loadingInvitations} class="text-[11px] text-text-placeholder hover:text-text-secondary disabled:opacity-50">Refresh</button><span class="text-[11px] text-text-tertiary">{invitations.filter((item) => item.status === 'active').length} active</span></div>
							</div>
							{#if inviteCreateNotice}<div class="mb-2 rounded-[6px] border border-success-soft/30 bg-success-bg px-3 py-2 text-[12px] text-success-soft break-words">{inviteCreateNotice}</div>{/if}
							{#if invitationsError}<div class="mb-2 rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft break-words">{invitationsError}</div>{/if}
							{#if loadingInvitations}
								<div class="flex items-center gap-2 py-2 text-[12px] text-text-tertiary"><Loader2 class="h-3.5 w-3.5 animate-spin" /> Loading invitations…</div>
							{:else if invitations.length === 0}
								<div class="rounded-[7px] bg-bg-primary px-3 py-2 text-[12px] text-text-tertiary">No invite links.</div>
							{:else}
								<div class="space-y-1.5">
									{#each invitations as invitation (invitation.token)}
										<div class="rounded-[7px] border border-border-subtle bg-bg-primary px-3 py-2">
											<div class="flex items-center justify-between gap-3">
												<div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><span class="inline-flex rounded bg-brand-bg px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-brand-muted-fg">{invitation.role}</span><span class="text-[11px] text-text-tertiary">{invitation.useCount} use{invitation.useCount !== 1 ? 's' : ''}{invitation.maxUses ? ` / ${invitation.maxUses}` : ''}</span></div><div class="mt-0.5 text-[10px] text-text-placeholder">{invitation.status === 'active' ? formatInviteExpiry(invitation.expiresInSeconds) : invitation.status === 'revoked' ? 'Revoked' : 'All uses exhausted'}</div></div>
												{#if invitation.status === 'active'}<div class="flex shrink-0 items-center gap-1"><button type="button" title="Copy invite link" onclick={() => { void copyInviteLink(invitation.token); }} class="inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-brand">{#if copiedInviteToken === invitation.token}<Check class="h-3.5 w-3.5 text-success-soft" />{:else}<Copy class="h-3.5 w-3.5" />{/if}</button><button type="button" title="Revoke invite" onclick={() => { void revokeInvite(invitation.token); }} class="inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-error-soft"><Trash2 class="h-3.5 w-3.5" /></button></div>{/if}
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				</section>

				{#if showInvitePanel}
					<div class="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim p-4" role="presentation" onclick={() => { showInvitePanel = false; }} onkeydown={(event) => { if (event.key === 'Escape') showInvitePanel = false; }}>
						<div class="w-full max-w-sm rounded-[10px] border border-border-subtle bg-bg-surface p-5 shadow-xl" role="dialog" aria-modal="true" tabindex="-1" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
							<div class="mb-4 flex items-start justify-between gap-3"><div><h3 class="text-[15px] font-medium text-text-primary">Create invite link</h3><p class="mt-1 text-[12px] text-text-tertiary">Choose a role and expiry.</p></div><button type="button" onclick={() => { showInvitePanel = false; }} class="inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"><X class="h-4 w-4" /></button></div>
							{#if inviteCreateError}<div class="mb-3 rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft break-words">{inviteCreateError}</div>{/if}
							<div class="space-y-3"><div><label class="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="invite-role">Role</label><select id="invite-role" bind:value={inviteRole} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary focus:border-brand/40 focus:outline-none"><option value="builder">Builder</option><option value="guest">Guest</option><option value="host">Host</option></select></div><div><label class="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="invite-ttl">Valid for</label><select id="invite-ttl" bind:value={inviteTtlDays} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary focus:border-brand/40 focus:outline-none"><option value={1}>1 day</option><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option></select></div><div><label class="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="invite-max-uses">Max uses <span class="normal-case tracking-normal text-text-placeholder">(0 = unlimited)</span></label><input id="invite-max-uses" type="number" bind:value={inviteMaxUses} min="0" max="10000" step="1" class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary focus:border-brand/40 focus:outline-none" /></div></div>
							<div class="mt-5 flex justify-end gap-2"><button type="button" onclick={() => { showInvitePanel = false; }} class="rounded-[6px] border border-border-subtle bg-bg-hover px-4 py-2 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-secondary">Cancel</button><button type="button" onclick={() => { void createInvite(); }} disabled={creatingInvite} class="inline-flex items-center gap-1.5 rounded-[6px] bg-brand px-4 py-2 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50">{#if creatingInvite}<Loader2 class="h-3.5 w-3.5 animate-spin" /> Creating…{:else}<Link class="h-3.5 w-3.5" /> Create link{/if}</button></div>
						</div>
					</div>
				{/if}

				<section class="overflow-hidden rounded-[10px] border border-border-subtle bg-bg-surface">
					<div class="border-b border-border-subtle px-4 py-3 sm:px-5">
						<div class="flex items-center gap-2.5">
							<Mic class="h-4 w-4 text-text-tertiary" />
							<div>
								<div class="text-[15px] font-medium text-text-primary">Voice lexicon</div>
								<div class="text-[12px] text-text-tertiary">Shared words preserved during dictation in this space.</div>
							</div>
						</div>
					</div>
					<div class="p-4 sm:p-5">
						<VoiceLexiconEditor
							entries={voiceLexiconEntries}
							loading={voiceLexiconLoading}
							error={voiceLexiconError}
							canManage={canManageVoiceLexicon}
							emptyText="No shared voice terms yet"
							addPlaceholder="Add a space-specific product, person, acronym, or phrase"
							onrefresh={loadSpaceVoiceLexicon}
							onadd={addSpaceVoiceLexiconTerm}
							onupdate={updateSpaceVoiceLexiconTerm}
							ondelete={deleteSpaceVoiceLexiconTerm}
						/>
					</div>
				</section>

				<section class="overflow-hidden rounded-[10px] border border-border-subtle bg-bg-surface">
					<div class="border-b border-border-subtle px-4 py-3 sm:px-5"><div class="flex items-center gap-2.5"><Terminal class="h-4 w-4 text-text-tertiary" /><div><div class="text-[15px] font-medium text-text-primary">Runtime inputs</div><div class="text-[12px] text-text-tertiary">Env vars and mounted spaces.</div></div></div></div>
					<div class="space-y-6 p-4 sm:p-5">
						<div class="space-y-3">
							<div class="text-[12px] font-medium text-text-secondary">Environment</div>
							<div class="grid gap-2 sm:grid-cols-[160px_1fr_auto]"><input bind:value={envName} placeholder="NAME" class="min-h-9 min-w-0 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" /><input bind:value={envValue} placeholder="value" class="min-h-9 min-w-0 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" /><button type="button" onclick={addEnv} class="inline-flex min-h-9 items-center justify-center rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg hover:bg-brand-hover">Add</button></div>
							<div class="space-y-1.5">{#each env as item (item.name)}<div class="grid gap-2 rounded-[7px] bg-bg-primary px-3 py-2 sm:grid-cols-[160px_1fr_auto]"><code class="min-w-0 break-all text-[11px] text-text-primary">{item.name}</code><code class="min-w-0 break-all text-[11px] text-text-tertiary">{revealedEnvNames.has(item.name) ? item.value : '••••••••'}</code><div class="flex gap-3 sm:justify-end"><button type="button" onclick={() => toggleEnvReveal(item.name)} class="text-[11px] text-text-placeholder hover:text-text-secondary">{revealedEnvNames.has(item.name) ? 'Hide' : 'Reveal'}</button><button type="button" onclick={() => removeEnv(item.name)} class="text-[11px] text-text-placeholder hover:text-error-soft">Remove</button></div></div>{:else}<div class="rounded-[7px] bg-bg-primary px-3 py-2 text-[12px] text-text-tertiary">No variables.</div>{/each}</div>
						</div>

						<div class="border-t border-border-subtle pt-5 space-y-3">
							<div class="flex items-center gap-2 text-[12px] font-medium text-text-secondary"><PackagePlus class="h-3.5 w-3.5 text-text-tertiary" /> Mounted spaces</div>
							<p class="max-w-2xl text-[11px] leading-relaxed text-text-tertiary">Mounted spaces are read-only under <code class="font-mono text-text-secondary">/mods/&lt;slug&gt;</code>. Prompts and skills are available to the agent. Changes restart the sandbox.</p>
							<div class="grid gap-2 lg:grid-cols-[1fr_1fr_1fr_auto]"><input bind:value={modSpaceId} placeholder="Mod Space UUID" class="min-h-9 min-w-0 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" /><input bind:value={modName} placeholder="Display name" class="min-h-9 min-w-0 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" /><input bind:value={modMountSlug} placeholder="Mount slug" class="min-h-9 min-w-0 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" /><button type="button" onclick={addMod} disabled={modSaving || !modSpaceId.trim()} class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg hover:bg-brand-hover disabled:opacity-50">{#if modSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if} Add</button></div>
							{#if modError}<div class="rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft break-words">{modError}</div>{/if}{#if modRestartMessage}<div class="rounded-[6px] border border-success-soft/30 bg-success-bg px-3 py-2 text-[12px] text-success-soft">{modRestartMessage}</div>{/if}
							<div class="space-y-1.5">{#each mods as mod (mod.id)}<div class="grid gap-2 rounded-[7px] bg-bg-primary px-3 py-2 md:grid-cols-[1fr_auto]"><div class="min-w-0"><div class="truncate text-[12px] font-medium text-text-secondary">{mod.name ?? mod.modSpaceName ?? mod.modSpaceId}</div><div class="mt-0.5 break-all font-mono text-[10px] text-text-placeholder">{mod.mountPath} · {mod.modSpaceId}</div><input value={mod.mountSlug} onblur={(event) => { const slug = (event.currentTarget as HTMLInputElement).value.trim(); if (slug !== mod.mountSlug) { void updateModMountSlug(mod, slug); } }} onkeydown={(event) => { if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) { event.preventDefault(); const slug = (event.currentTarget as HTMLInputElement).value.trim(); if (slug !== mod.mountSlug) { void updateModMountSlug(mod, slug); } } }} placeholder="Mount slug" class="mt-2 w-full rounded-[5px] border border-border-subtle bg-bg-input px-2 py-1.5 font-mono text-[11px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" /></div><div class="flex items-center justify-end gap-2 md:justify-start"><span class="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider {mod.enabled ? 'bg-success-bg text-success-soft' : 'bg-bg-hover text-text-placeholder'}">{mod.enabled ? 'enabled' : 'disabled'}</span><button type="button" onclick={() => toggleMod(mod)} disabled={modUpdatingId === mod.id} class="text-[11px] text-text-placeholder hover:text-text-secondary disabled:opacity-50">{mod.enabled ? 'Disable' : 'Enable'}</button><button type="button" onclick={() => removeMod(mod)} disabled={modUpdatingId === mod.id} class="text-[11px] text-text-placeholder hover:text-error-soft disabled:opacity-50">Remove</button></div></div>{:else}<div class="rounded-[7px] bg-bg-primary px-3 py-2 text-[12px] text-text-tertiary">No mounted spaces.</div>{/each}</div>
						</div>
					</div>
				</section>

				<section class="overflow-hidden rounded-[10px] border border-border-subtle bg-bg-surface">
					<div class="border-b border-border-subtle px-4 py-3 sm:px-5"><div class="flex items-center gap-2.5"><Network class="h-4 w-4 text-text-tertiary" /><div><div class="text-[15px] font-medium text-text-primary">Channels</div><div class="text-[12px] text-text-tertiary">External channel bindings.</div></div></div></div>
					<div class="space-y-3 p-4 sm:p-5">
						<div class="grid gap-2 sm:grid-cols-[1fr_auto]"><select bind:value={selectedChannelId} class="min-h-9 min-w-0 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none"><option value="">Select channel</option>{#each allChannels.filter((ch) => !channels.some((binding) => binding.channelId === ch.id)) as channel (channel.id)}<option value={channel.id}>{channel.provider} · {channel.name}</option>{/each}</select><button type="button" onclick={bindChannel} disabled={!selectedChannelId} class="inline-flex min-h-9 items-center justify-center rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg hover:bg-brand-hover disabled:opacity-50">Bind</button></div>
						<div class="space-y-1.5">{#each channels as binding (binding.id)}<div class="flex items-center justify-between gap-3 rounded-[7px] bg-bg-primary px-3 py-2"><span class="min-w-0 truncate text-[12px] text-text-secondary">{binding.channel?.provider ?? 'channel'} · {binding.channel?.name ?? binding.channelId}</span><button type="button" onclick={() => unbindChannel(binding.channelId)} class="shrink-0 text-[11px] text-text-placeholder hover:text-error-soft">Unbind</button></div>{:else}<div class="rounded-[7px] bg-bg-primary px-3 py-2 text-[12px] text-text-tertiary">No bound channels.</div>{/each}</div>
					</div>
				</section>

				<section class="overflow-hidden rounded-[10px] border border-border-subtle bg-bg-surface">
					<div class="flex flex-col gap-3 border-b border-border-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"><div class="flex min-w-0 items-center gap-2.5"><Settings class="h-4 w-4 text-text-tertiary" /><div class="min-w-0"><div class="text-[15px] font-medium text-text-primary">Sandbox</div><div class="text-[12px] text-text-tertiary">Policy, health, runtime image.</div></div></div><button type="button" onclick={forceRecoverSandbox} disabled={recoveringSandbox} class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50">{#if recoveringSandbox}<Loader2 class="h-3.5 w-3.5 animate-spin" /> Recovering{:else}<RefreshCw class="h-3.5 w-3.5" /> Force recover{/if}</button></div>
					<div class="space-y-5 p-4 sm:p-5">
						<div class="rounded-[8px] border border-border-subtle bg-bg-primary p-3">
							<div class="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><div class="text-[12px] font-medium text-text-secondary">Auto-destroy policy</div><div class="mt-0.5 text-[11px] text-text-tertiary">Current: {sandboxAutoDestroyMode === "never" ? "Never" : formatTtl(sandboxIdleTtlSeconds)}</div></div><button type="button" onclick={saveSandboxConfig} disabled={savingSandboxConfig} class="inline-flex min-h-9 items-center justify-center rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg hover:bg-brand-hover disabled:opacity-50">{savingSandboxConfig ? "Saving…" : "Save policy"}</button></div>
							<div class="grid grid-cols-1 gap-2 md:grid-cols-[180px_1fr]"><select bind:value={sandboxAutoDestroyMode} class="min-h-9 w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary focus:border-brand/40 focus:outline-none"><option value="idle">Destroy when idle</option><option value="never">Never destroy</option></select>{#if sandboxAutoDestroyMode === "idle"}<div class="grid gap-2 sm:grid-cols-[1fr_auto]"><input type="number" min="60" max="2592000" step="60" bind:value={sandboxIdleTtlSeconds} class="min-h-9 w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary focus:border-brand/40 focus:outline-none" /><span class="self-center text-[12px] text-text-tertiary">seconds · max 30d</span></div>{:else}<div class="rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-tertiary">Sandbox stays alive until stopped or replaced.</div>{/if}</div>
							{#if sandboxConfigError}<div class="mt-2 text-[12px] text-error-soft">{sandboxConfigError}</div>{/if}{#if sandboxConfigMessage}<div class="mt-2 text-[12px] text-success-soft">{sandboxConfigMessage}</div>{/if}
						</div>

						<div class="grid gap-3 lg:grid-cols-[1.15fr_0.85fr]">
							<div class="rounded-[8px] bg-bg-primary p-3 ring-1 ring-border-subtle"><div class="flex flex-wrap items-center gap-2"><span class={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${getSandboxStatusClass(sandbox?.status)}`}>{getSandboxLifecycleLabel(sandbox?.status)}</span><span class={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${getSandboxStatusClass(sandbox?.runtimeStatus)}`}>{getSandboxRuntimeLabel(sandbox?.runtimeStatus)}</span>{#if sandbox?.stopReason}<span class="inline-flex max-w-full items-center rounded-full bg-bg-hover px-2 py-0.5 text-[11px] text-text-tertiary ring-1 ring-border-subtle"><span class="truncate">{sandbox.stopReason}</span></span>{/if}</div><div class="mt-4 grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2"><div title={getSandboxActivityTitle()}><div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Activity</div><div class="mt-1 text-text-primary">{getSandboxActivityText()}</div></div><div title={getSandboxHeartbeatTitle()}><div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Heartbeat</div><div class="mt-1 text-text-primary">{formatRelativeTime(sandbox?.lastHeartbeatAt)}</div></div><div><div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Stopped at</div><div class="mt-1 text-text-primary">{formatRelativeTime(sandbox?.stoppedAt)}</div><div class="mt-0.5 break-words text-[11px] text-text-placeholder">{formatTime(sandbox?.stoppedAt)}</div></div><div class="min-w-0"><div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Pod</div><div class="mt-1 min-w-0 break-all font-mono text-[11px] text-text-primary">{sandbox?.podName ?? '—'}</div><div class="mt-0.5 break-all text-[11px] text-text-placeholder">{getSandboxMetaValue('podIp') || 'IP unavailable'}</div></div></div></div>
							<div class="grid grid-cols-1 gap-2 text-[12px] sm:grid-cols-2 lg:grid-cols-1"><div class="min-w-0 rounded-[8px] bg-bg-primary px-3 py-2 ring-1 ring-border-subtle"><div class="text-text-placeholder">Desired image</div><div class="mt-0.5 min-w-0 break-all font-mono text-[11px] leading-relaxed text-text-primary">{sandbox?.desiredImage ?? '—'}</div></div><div class="min-w-0 rounded-[8px] bg-bg-primary px-3 py-2 ring-1 ring-border-subtle"><div class="text-text-placeholder">Reported image</div><div class="mt-0.5 min-w-0 break-all font-mono text-[11px] leading-relaxed text-text-primary">{(sandbox?.reportedImageVersion ?? getSandboxMetaValue('imageVersion')) || '—'}</div></div><div class="rounded-[8px] bg-bg-primary px-3 py-2 ring-1 ring-border-subtle"><div class="text-text-placeholder">Report refreshed</div><div class="mt-0.5 text-text-primary">{formatRelativeTime(sandbox?.reportedAt)}</div></div></div>
						</div>
						{#if sandboxRecoveryMessage}<div class="rounded-[6px] border border-success-soft/30 bg-success-bg px-3 py-2 text-[12px] text-success-soft">{sandboxRecoveryMessage}</div>{/if}{#if sandboxRecoveryError}<div class="rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft break-words">{sandboxRecoveryError}</div>{/if}
					</div>
				</section>
			{/if}
		</div>
	</main>
</div>
