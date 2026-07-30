<script lang="ts">
import {
	type DefaultSpaceModDefinition,
	getDefaultSpaceModsForEnv,
	normalizeCohubRuntimeEnv,
} from "@cohub/protocol";
import type {
	Channel,
	DiscordChannelConfig,
	FeishuChannelConfig,
	SandboxSpecId,
	SpaceAccessPolicy,
	SpaceChannelBindingRecord,
	SpaceEnvInput,
	SpaceInvitation,
	SpaceMember,
	SpaceModListItem,
	SpaceRecord,
	SpaceRole,
	SpaceSandboxAutoDestroyPolicy,
} from "@neta-art/cohub";
import {
	ArrowLeft,
	Check,
	Copy,
	Eye,
	EyeOff,
	Globe,
	Link,
	Loader2,
	Network,
	PackagePlus,
	Pencil,
	Plus,
	RefreshCw,
	Settings,
	Terminal,
	Trash2,
	Upload,
	Users,
	X,
	Zap,
} from "lucide-svelte";
import { onDestroy } from "svelte";
import { browser } from "$app/environment";
import { goto } from "$app/navigation";
import { PUBLIC_COHUB_ENV } from "$env/static/public";
import {
	channelHealthClass,
	channelHealthDetail,
	channelHealthLabel,
	channelHealthMessage,
} from "$lib/channel-health";
import ChannelModelPicker from "$lib/components/ChannelModelPicker.svelte";
import Sheet from "$lib/components/Sheet.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { uploadSpaceAvatarImage } from "$lib/public-asset-images";
import { sdk } from "$lib/sdk";
import { validateSpaceSlugInput } from "$lib/slug-rules";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { billingConversion } from "$lib/stores/billing-conversion.svelte";
import { invalidateCachedSpaceMembers } from "$lib/stores/space-profile-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import SandboxSpecPicker from "./SandboxSpecPicker.svelte";

type SandboxSpecOption = {
	id: SandboxSpecId;
	rank: number;
	label: string;
	description: string;
	requiredPlan: string | null;
	resources: {
		limits: Record<string, string>;
		requests: Record<string, string>;
	};
};

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
const recommendedBaseMod =
	getDefaultSpaceModsForEnv(normalizeCohubRuntimeEnv(PUBLIC_COHUB_ENV))[0] ??
	null;

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
let savingChannelConfigIds = $state<Set<string>>(new Set());
let modSpaceId = $state("");
let modName = $state("");
let modMountSlug = $state("");
let modError = $state("");
let modSaving = $state(false);
let modUpdatingId = $state<string | null>(null);
let modRestartMessage = $state("");
let modRestartTimer: ReturnType<typeof setTimeout> | null = null;
let copiedModSpaceId = $state<string | null>(null);
let copiedModSpaceIdTimer: ReturnType<typeof setTimeout> | null = null;
let revealedEnvNames = $state<Set<string>>(new Set());
let copiedMemberUserId = $state<string | null>(null);
let copiedMemberTimer: ReturnType<typeof setTimeout> | null = null;
let addingMemberUuid = $state("");
let addingMemberRole = $state<SpaceRole>("guest");
let savingMember = $state(false);
let accessError = $state("");
let envError = $state("");
let channelError = $state("");
let channelHealthRefreshTimer: ReturnType<typeof setInterval> | null = null;
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
let sandboxSpec = $state<SandboxSpecId>("standard");
let appliedSandboxSpec = $state<SandboxSpecId | null>(null);
let sandboxSpecPendingRestart = $state(false);
let allowedSandboxSpec = $state<SandboxSpecId>("standard");
const defaultSandboxSpecs: Record<string, SandboxSpecOption> = {
	standard: {
		id: "standard",
		rank: 0,
		label: "Standard",
		description: "Everyday building",
		requiredPlan: null,
		resources: {
			limits: { cpu: "2", memory: "4Gi" },
			requests: { cpu: "100m", memory: "256Mi" },
		},
	},
	boost: {
		id: "boost",
		rank: 1,
		label: "Boost",
		description: "Faster builds and heavier dev servers",
		requiredPlan: "Pro",
		resources: {
			limits: { cpu: "4", memory: "8Gi" },
			requests: { cpu: "250m", memory: "768Mi" },
		},
	},
	ultra: {
		id: "ultra",
		rank: 2,
		label: "Ultra",
		description: "Highest-priority compute for large work",
		requiredPlan: "Max",
		resources: {
			limits: { cpu: "4", memory: "12Gi" },
			requests: { cpu: "500m", memory: "1536Mi" },
		},
	},
};
let sandboxSpecs =
	$state<Record<string, SandboxSpecOption>>(defaultSandboxSpecs);
let specPickerOpen = $state(false);
let savingSandboxSpec = $state(false);
let sandboxSpecMessage = $state("");
let sandboxSpecError = $state("");
let sandboxSpecMessageTimer: ReturnType<typeof setTimeout> | null = null;
let renamingSpace = $state(false);
let renameInput = $state("");
let renameSaving = $state(false);
let renameError = $state("");
let spaceDescriptionDraft = $state("");
let spaceDescriptionSaving = $state(false);
let spaceProfileError = $state("");
let spaceAvatarUploading = $state(false);
let editingSpaceSlug = $state(false);
let spaceSlugDraft = $state("");
let spaceSlugSaving = $state(false);
let spaceSlugError = $state("");
let copiedSpaceId = $state(false);
let copiedSpaceIdTimer: ReturnType<typeof setTimeout> | null = null;
let copiedSpaceSlugLink = $state(false);
let copiedSpaceSlugLinkTimer: ReturnType<typeof setTimeout> | null = null;
const shouldShowBaseModRecommendation = $derived(
	recommendedBaseMod
		? !mods.some((mod) => mod.modSpaceId === recommendedBaseMod.modSpaceId)
		: false,
);
const canEditSpaceProfile = $derived(
	space?.access?.permissions.includes("space.edit") === true,
);
const canManageSpaceMembers = $derived(
	space?.access?.permissions.includes("member.manage") === true,
);
const canManageSpaceChannels = $derived(
	space?.access?.permissions.includes("channel.manage") === true,
);
const canManageSpaceMods = $derived(
	space?.access?.permissions.includes("mod.manage") === true,
);
const canManageSpaceSandbox = $derived(
	space?.access?.permissions.includes("sandbox.manage") === true,
);
const memberRoleOptions: { value: SpaceRole; label: string }[] = [
	{ value: "guest", label: "Guest" },
	{ value: "builder", label: "Builder" },
	{ value: "host", label: "Host" },
];

onDestroy(() => {
	if (inviteNoticeTimer) clearTimeout(inviteNoticeTimer);
	if (copiedInviteTimer) clearTimeout(copiedInviteTimer);
	if (modRestartTimer) clearTimeout(modRestartTimer);
	if (copiedModSpaceIdTimer) clearTimeout(copiedModSpaceIdTimer);
	if (copiedMemberTimer) clearTimeout(copiedMemberTimer);
	if (copiedSpaceIdTimer) clearTimeout(copiedSpaceIdTimer);
	if (copiedSpaceSlugLinkTimer) clearTimeout(copiedSpaceSlugLinkTimer);
	if (sandboxSpecMessageTimer) clearTimeout(sandboxSpecMessageTimer);
	if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);
	if (channelHealthRefreshTimer) clearInterval(channelHealthRefreshTimer);
	if (scrollSpyRaf) cancelAnimationFrame(scrollSpyRaf);
	scrollSpyObserver?.disconnect();
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
	sandboxSpec = record?.meta?.config?.sandbox?.spec ?? sandboxSpec;
}

async function loadSandboxConfig() {
	const result = await sdk
		.space(spaceId)
		.getConfig()
		.catch(() => null);
	if (!result?.config?.sandbox) return;
	const config = result.config.sandbox;
	sandboxSpec = config.spec ?? "standard";
	appliedSandboxSpec = config.appliedSpec ?? null;
	sandboxSpecPendingRestart = config.specPendingRestart === true;
	allowedSandboxSpec = config.allowedSpec ?? "standard";
	sandboxSpecs =
		(config.specs as Record<string, SandboxSpecOption> | undefined) ??
		sandboxSpecs;
}

function getSandboxSpecLabel(specId: SandboxSpecId | null | undefined) {
	return sandboxSpecs[specId ?? ""]?.label ?? (specId ? specId : "Standard");
}

function getSandboxSpecSummary(specId: SandboxSpecId | null | undefined) {
	const spec = sandboxSpecs[specId ?? ""];
	if (!spec) return "2 vCPU · 4 Gi";
	return `${spec.resources?.limits?.cpu ?? "2"} vCPU · ${spec.resources?.limits?.memory ?? "4Gi"}`;
}

function openSandboxSpecUpgrade(specId: SandboxSpecId) {
	const spec = sandboxSpecs[specId];
	billingConversion.openFromIntent({
		level: "hard",
		reason: "feature_not_entitled",
		audience: "unknown",
		preferredOfferKind: "upgrade",
		title: `Upgrade for ${spec?.label ?? "better"} sandboxes`,
		message: `Choose a higher plan to use ${spec?.label ?? specId} with ${spec?.resources?.limits?.cpu ?? "more"} vCPU and ${spec?.resources?.limits?.memory ?? "more memory"}.`,
		primaryAction: { label: "View plans", action: "open_billing_conversion" },
		source: "sandbox_spec_picker",
	});
}

function setSandboxSpecMessage(message: string) {
	sandboxSpecMessage = message;
	if (sandboxSpecMessageTimer) clearTimeout(sandboxSpecMessageTimer);
	sandboxSpecMessageTimer = setTimeout(() => {
		sandboxSpecMessage = "";
	}, 4000);
}

async function saveSandboxSpec(spec: SandboxSpecId) {
	if (!canManageSpaceSandbox || savingSandboxSpec) return;
	specPickerOpen = false;
	if (spec === sandboxSpec) return;
	// Optimistic: reflect the choice immediately, save in the background.
	const previousSpec = sandboxSpec;
	sandboxSpec = spec;
	savingSandboxSpec = true;
	sandboxSpecMessage = "";
	sandboxSpecError = "";
	try {
		const result = await sdk.space(spaceId).updateConfig({ sandbox: { spec } });
		space = result.space;
		cacheSpaceRecordSoon(result.space);
		applySandboxConfigFromSpace(result.space);
		void Promise.all([loadSandboxConfig(), loadSandbox()]);
		const sandboxResult = (
			result as unknown as {
				sandbox?: { pendingRestart?: boolean; resized?: boolean };
			}
		).sandbox;
		if (sandboxResult?.pendingRestart) sandboxSpecPendingRestart = true;
		setSandboxSpecMessage(
			sandboxResult?.pendingRestart
				? "Saved. Restart the sandbox to apply."
				: "Spec updated.",
		);
	} catch (err) {
		sandboxSpec = previousSpec;
		if (!billingConversion.handleHttpError(err)) {
			sandboxSpecError =
				err instanceof Error ? err.message : "Failed to save sandbox spec";
		}
	} finally {
		savingSandboxSpec = false;
	}
}

function formatTtl(seconds: number): string {
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

async function saveSandboxConfig() {
	if (!canManageSpaceSandbox) return;
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
		sandboxConfigMessage = "Hibernation policy saved.";
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

function getSpaceOwnerUsername(record: SpaceRecord | null): string {
	return record?.ownerProfile?.username?.trim() ?? "";
}

function getSpaceSlug(record: SpaceRecord | null): string {
	return record?.slug?.trim() ?? "";
}

function getSpacePublicPath(record: SpaceRecord | null): string {
	const username = getSpaceOwnerUsername(record);
	const slug = getSpaceSlug(record);
	return username && slug ? `/${username}/${slug}` : "";
}

function getSpacePrettyUrlHint(record: SpaceRecord | null): string {
	const hasUsername = Boolean(getSpaceOwnerUsername(record));
	const hasSlug = Boolean(getSpaceSlug(record));
	if (hasUsername && hasSlug) return "";
	if (!hasUsername && !hasSlug)
		return "Add a space slug and username for a cleaner URL.";
	if (!hasUsername)
		return "Add username in Profile to complete the pretty URL.";
	return "Add a space slug for a cleaner URL.";
}

function formatCompactId(id: string): string {
	if (!id) return "";
	if (id.length <= 13) return id;
	return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

async function handleRenameSpace(newName: string) {
	renameSaving = true;
	renameError = "";
	try {
		const result = await sdk.space(spaceId).rename(newName);
		space = result.space;
		cacheSpaceRecordSoon(result.space);
		renamingSpace = false;
	} catch (err) {
		renameError = err instanceof Error ? err.message : "Failed to rename space";
	} finally {
		renameSaving = false;
	}
}

function beginSpaceSlugEdit() {
	if (!canEditSpaceProfile || spaceSlugSaving) return;
	spaceSlugDraft = space?.slug ?? "";
	spaceSlugError = "";
	editingSpaceSlug = true;
}

function cancelSpaceSlugEdit() {
	if (spaceSlugSaving) return;
	editingSpaceSlug = false;
	spaceSlugDraft = "";
	spaceSlugError = "";
}

function handleSpaceSlugKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
		cancelSpaceSlugEdit();
		return;
	}
	if (event.key === "Enter" && !isComposingKeyboardEvent(event)) {
		event.preventDefault();
		void saveSpaceSlug();
	}
}

async function saveSpaceSlug() {
	if (!space || spaceSlugSaving) return;
	spaceSlugError = "";
	const result = validateSpaceSlugInput(spaceSlugDraft, {
		currentValue: space.slug,
	});
	if (result.error) {
		spaceSlugError = result.error;
		return;
	}
	const nextSlug = result.value;
	if (nextSlug === space.slug) {
		editingSpaceSlug = false;
		return;
	}
	spaceSlugSaving = true;
	try {
		const updateResult = await sdk.space(spaceId).update({ slug: nextSlug });
		space = updateResult.space;
		cacheSpaceRecordSoon(updateResult.space);
		editingSpaceSlug = false;
		spaceSlugDraft = "";
	} catch (err) {
		spaceSlugError =
			err instanceof Error ? err.message : "Failed to save space slug";
	} finally {
		spaceSlugSaving = false;
	}
}

async function copySpaceId() {
	try {
		await navigator.clipboard.writeText(spaceId);
		copiedSpaceId = true;
		if (copiedSpaceIdTimer) clearTimeout(copiedSpaceIdTimer);
		copiedSpaceIdTimer = setTimeout(() => {
			copiedSpaceId = false;
		}, 2000);
	} catch {
		// Clipboard failures are non-critical.
	}
}

async function copySpacePublicLink() {
	const path = getSpacePublicPath(space);
	if (!path) return;
	try {
		await navigator.clipboard.writeText(`${window.location.origin}${path}`);
		copiedSpaceSlugLink = true;
		if (copiedSpaceSlugLinkTimer) clearTimeout(copiedSpaceSlugLinkTimer);
		copiedSpaceSlugLinkTimer = setTimeout(() => {
			copiedSpaceSlugLink = false;
		}, 2000);
	} catch {
		// Clipboard failures are non-critical.
	}
}

async function saveSpaceDescription() {
	if (spaceDescriptionSaving) return;
	spaceDescriptionSaving = true;
	spaceProfileError = "";
	try {
		const result = await sdk.space(spaceId).profile({
			description: spaceDescriptionDraft.trim() || null,
		});
		space = result.space;
		cacheSpaceRecordSoon(result.space);
	} catch (err) {
		spaceProfileError =
			err instanceof Error ? err.message : "Failed to save space profile";
	} finally {
		spaceDescriptionSaving = false;
	}
}

function handleDescriptionKeydown(event: KeyboardEvent) {
	if (
		(event.metaKey || event.ctrlKey) &&
		event.key === "Enter" &&
		!isComposingKeyboardEvent(event)
	) {
		event.preventDefault();
		void saveSpaceDescription();
	}
}

async function uploadSpaceAvatar(file: File) {
	if (!canEditSpaceProfile || spaceAvatarUploading) return;
	spaceAvatarUploading = true;
	spaceProfileError = "";
	try {
		const asset = await uploadSpaceAvatarImage({ spaceId, file });
		const result = await sdk.space(spaceId).profile({
			description: space?.description ?? null,
			avatarUrl: asset.publicUrl,
		});
		space = result.space;
		cacheSpaceRecordSoon(result.space);
	} catch (err) {
		spaceProfileError =
			err instanceof Error ? err.message : "Failed to upload space avatar";
	} finally {
		spaceAvatarUploading = false;
	}
}

function handleSpaceAvatarFileChange(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0];
	input.value = "";
	if (file) void uploadSpaceAvatar(file);
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
	modRestartMessage = "Restarting sandbox to apply mod changes.";
	if (modRestartTimer) clearTimeout(modRestartTimer);
	modRestartTimer = setTimeout(() => {
		modRestartMessage = "";
	}, 6000);
}

async function loadMods() {
	const result = await sdk.space(spaceId).mods.list();
	mods = result.items;
}

async function forceRecoverSandbox() {
	if (recoveringSandbox || !canManageSpaceSandbox) return;
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
			? "Sandbox recovered."
			: "Recovery completed.";
		await Promise.all([loadSandbox(), loadSandboxConfig()]);
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
			sandboxConfigResult,
			invitationResult,
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
				.getConfig()
				.catch(() => null),
			sdk
				.space(spaceId)
				.invitations.list()
				.catch(() => ({ items: [] })),
		]);
		space = spaceResult;
		spaceDescriptionDraft = spaceResult.description ?? "";
		cacheSpaceRecordSoon(spaceResult);
		access = accessResult;
		members = memberResult.items;
		env = envResult.env;
		channels = channelResult;
		mods = modResult.items;
		allChannels = allChannelResult;
		sandbox = sandboxResult?.sandbox ?? null;
		if (sandboxConfigResult?.config?.sandbox) {
			const sandboxConfig = sandboxConfigResult.config.sandbox;
			sandboxSpec = sandboxConfig.spec ?? "standard";
			appliedSandboxSpec = sandboxConfig.appliedSpec ?? null;
			allowedSandboxSpec = sandboxConfig.allowedSpec ?? "standard";
			sandboxSpecs =
				(sandboxConfig.specs as
					| Record<string, SandboxSpecOption>
					| undefined) ?? sandboxSpecs;
		}
		invitations = invitationResult.items;
		applySandboxConfigFromSpace(spaceResult);
		if (channelHealthRefreshTimer) clearInterval(channelHealthRefreshTimer);
		channelHealthRefreshTimer = setInterval(() => {
			void refreshChannelHealth();
		}, 15_000);
	} catch (err) {
		error = err instanceof Error ? err.message : "Failed to load settings";
	} finally {
		loading = false;
	}
}

async function refreshChannelHealth() {
	if (loading) return;
	try {
		// Only refresh bound-channel health; keep allChannels from full load.
		const channelResult = await sdk.space(spaceId).channels.list();
		channels = channelResult;
	} catch {
		// Silent refresh — keep last known health.
	}
}

async function setAccess(body: {
	signed_in_user?: SpaceRole | null;
	anonymous_user?: SpaceRole | null;
}) {
	if (!canManageSpaceMembers) return;
	accessError = "";
	try {
		access = await sdk.space(spaceId).access.set(body);
	} catch (err) {
		accessError = err instanceof Error ? err.message : "Failed to save access";
	}
}

async function addEnv() {
	if (!canEditSpaceProfile || !envName.trim()) return;
	envError = "";
	try {
		const result = await sdk
			.space(spaceId)
			.env.create({ name: envName.trim(), value: envValue });
		env = result.env;
		envName = "";
		envValue = "";
	} catch (err) {
		envError = err instanceof Error ? err.message : "Failed to add variable";
	}
}

async function removeEnv(name: string) {
	if (!canEditSpaceProfile) return;
	envError = "";
	try {
		const result = await sdk.space(spaceId).env.remove(name);
		env = result.env;
	} catch (err) {
		envError = err instanceof Error ? err.message : "Failed to remove variable";
	}
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
	if (!canManageSpaceMembers || !addingMemberUuid.trim() || savingMember)
		return;
	savingMember = true;
	addingMemberError = "";
	try {
		await sdk
			.space(spaceId)
			.members.update(addingMemberUuid.trim(), addingMemberRole);
		invalidateCachedSpaceMembers(spaceId);
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

async function copyModSpaceId(id: string) {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(id);
		} else {
			const textarea = document.createElement("textarea");
			textarea.value = id;
			textarea.setAttribute("readonly", "true");
			textarea.style.position = "fixed";
			textarea.style.opacity = "0";
			document.body.appendChild(textarea);
			textarea.select();
			const copied = document.execCommand("copy");
			document.body.removeChild(textarea);
			if (!copied) return;
		}
		copiedModSpaceId = id;
		if (copiedModSpaceIdTimer) clearTimeout(copiedModSpaceIdTimer);
		copiedModSpaceIdTimer = setTimeout(() => {
			copiedModSpaceId = null;
		}, 2000);
	} catch {
		// ignore copy failure silently
	}
}

function selectAddingMemberRole(role: SpaceRole) {
	if (!canManageSpaceMembers) return;
	addingMemberRole = role;
}

async function selectMemberRole(
	userId: string,
	currentRole: SpaceRole,
	nextRole: SpaceRole,
) {
	if (currentRole === nextRole) return;
	await updateMemberRole(userId, nextRole);
}

async function updateMemberRole(userId: string, role: SpaceRole) {
	if (!canManageSpaceMembers) return;
	updatingMemberUserId = userId;
	addingMemberError = "";
	try {
		await sdk.space(spaceId).members.update(userId, role);
		invalidateCachedSpaceMembers(spaceId);
		await loadMembers();
	} catch (err) {
		addingMemberError =
			err instanceof Error ? err.message : "Failed to update member";
	} finally {
		updatingMemberUserId = null;
	}
}

async function removeMember(userId: string) {
	if (!canManageSpaceMembers) return;
	if (!window.confirm("Remove this member from the space?")) return;
	removingMemberUserId = userId;
	addingMemberError = "";
	try {
		await sdk.space(spaceId).members.remove(userId);
		invalidateCachedSpaceMembers(spaceId);
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
	if (creatingInvite || !canManageSpaceMembers) return;
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
			? "Invite link copied to clipboard."
			: "Invite link created — copy it from the list below.";
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
	if (!canManageSpaceMembers) return;
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

async function saveChannelConfig(
	binding: SpaceChannelBindingRecord,
	config: NonNullable<SpaceChannelBindingRecord["config"]>,
	errorMessage: string,
) {
	if (!canManageSpaceChannels) return;
	channelError = "";
	savingChannelConfigIds = new Set(savingChannelConfigIds).add(binding.id);
	try {
		const updated = await sdk
			.space(spaceId)
			.channels.updateConfig(binding.channelId, config);
		channels = channels.map((item) =>
			item.id === binding.id
				? { ...item, ...updated, channel: item.channel }
				: item,
		);
	} catch (err) {
		channelError = err instanceof Error ? err.message : errorMessage;
	} finally {
		const next = new Set(savingChannelConfigIds);
		next.delete(binding.id);
		savingChannelConfigIds = next;
	}
}

async function saveChannelModel(
	binding: SpaceChannelBindingRecord,
	model: { provider: string; id: string } | null,
) {
	const nextConfig = { ...(binding.config ?? {}), model };
	await saveChannelConfig(binding, nextConfig, "Failed to save channel model");
}

async function saveDiscordRequireMention(
	binding: SpaceChannelBindingRecord,
	requireMentionInGuild: boolean,
) {
	const current = (binding.config ?? {}) as DiscordChannelConfig;
	await saveChannelConfig(
		binding,
		{
			...current,
			inbound: {
				...(current.inbound ?? {}),
				requireMentionInGuild,
			},
		},
		"Failed to save Discord mention setting",
	);
}

async function saveFeishuRequireMention(
	binding: SpaceChannelBindingRecord,
	requireMentionInGroup: boolean,
) {
	const current = (binding.config ?? {}) as FeishuChannelConfig;
	await saveChannelConfig(
		binding,
		{
			...current,
			inbound: {
				...(current.inbound ?? {}),
				requireMentionInGroup,
			},
		},
		"Failed to save Feishu mention setting",
	);
}

async function bindChannel() {
	if (!canManageSpaceChannels || !selectedChannelId) return;
	channelError = "";
	try {
		await sdk.space(spaceId).channels.bind(selectedChannelId);
		channels = await sdk.space(spaceId).channels.list();
		selectedChannelId = "";
	} catch (err) {
		channelError =
			err instanceof Error ? err.message : "Failed to bind channel";
	}
}

async function unbindChannel(channelId: string) {
	if (!canManageSpaceChannels) return;
	channelError = "";
	try {
		await sdk.space(spaceId).channels.unbind(channelId);
		channels = await sdk.space(spaceId).channels.list();
	} catch (err) {
		channelError =
			err instanceof Error ? err.message : "Failed to unbind channel";
	}
}

async function addMod() {
	if (!canManageSpaceMods) return;
	const target = modSpaceId.trim();
	if (!target || modSaving) return;
	if (mods.some((mod) => mod.modSpaceId === target)) {
		modError = "Mod space is already mounted";
		return;
	}
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

function fillRecommendedMod(mod: DefaultSpaceModDefinition) {
	if (!canManageSpaceMods) return;
	modSpaceId = mod.modSpaceId;
	modName = mod.name ?? "";
	modMountSlug = mod.mountSlug ?? "";
	modError = "";
}

async function toggleMod(mod: SpaceModListItem) {
	if (!canManageSpaceMods) return;
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
	if (!canManageSpaceMods) return;
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
	if (!canManageSpaceMods) return;
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

type SettingsSection =
	| "profile"
	| "access"
	| "environment"
	| "channels"
	| "sandbox";

const settingsSections: {
	id: SettingsSection;
	label: string;
	icon: typeof Globe;
}[] = [
	{ id: "profile", label: "Profile", icon: Globe },
	{ id: "access", label: "Access", icon: Users },
	{ id: "environment", label: "Environment", icon: Terminal },
	{ id: "channels", label: "Channels", icon: Network },
	{ id: "sandbox", label: "Sandbox", icon: Settings },
];

function isSettingsSection(
	value: string | null | undefined,
): value is SettingsSection {
	return settingsSections.some((section) => section.id === value);
}

function sectionElementId(sectionId: SettingsSection) {
	return sectionId;
}

let activeSection = $state<SettingsSection>("profile");
let settingsMainEl = $state<HTMLElement | null>(null);
let scrollSpyObserver: IntersectionObserver | null = null;
let scrollSpyRaf = 0;
let programmaticScroll = false;
let programmaticScrollTimer: ReturnType<typeof setTimeout> | null = null;

function setActiveSection(
	sectionId: SettingsSection,
	{ syncHash = false } = {},
) {
	if (activeSection !== sectionId) activeSection = sectionId;
	if (!syncHash || !browser) return;
	const nextHash = `#${sectionId}`;
	if (window.location.hash === nextHash) return;
	history.replaceState(
		null,
		"",
		`${window.location.pathname}${window.location.search}${nextHash}`,
	);
}

function scrollToSection(sectionId: SettingsSection, { smooth = true } = {}) {
	const el = document.getElementById(sectionElementId(sectionId));
	if (!el) return;
	setActiveSection(sectionId, { syncHash: true });
	programmaticScroll = true;
	if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);
	el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
	programmaticScrollTimer = setTimeout(
		() => {
			programmaticScroll = false;
		},
		smooth ? 700 : 50,
	);
}

function handleSectionNavClick(event: MouseEvent, sectionId: SettingsSection) {
	event.preventDefault();
	scrollToSection(sectionId);
}

function updateActiveSectionFromScroll() {
	if (!settingsMainEl || programmaticScroll) return;
	const mainTop = settingsMainEl.getBoundingClientRect().top;
	const marker = mainTop + 48;
	let next: SettingsSection = settingsSections[0].id;
	for (const section of settingsSections) {
		const el = document.getElementById(sectionElementId(section.id));
		if (!el) continue;
		if (el.getBoundingClientRect().top <= marker) next = section.id;
	}
	setActiveSection(next, { syncHash: true });
}

function scheduleActiveSectionFromScroll() {
	if (scrollSpyRaf) cancelAnimationFrame(scrollSpyRaf);
	scrollSpyRaf = requestAnimationFrame(() => {
		scrollSpyRaf = 0;
		updateActiveSectionFromScroll();
	});
}

function bindScrollSpy(main: HTMLElement | null) {
	scrollSpyObserver?.disconnect();
	scrollSpyObserver = null;
	if (!main || typeof IntersectionObserver === "undefined") return;
	scrollSpyObserver = new IntersectionObserver(
		() => scheduleActiveSectionFromScroll(),
		{
			root: main,
			rootMargin: "-12% 0px -72% 0px",
			threshold: [0, 0.1, 0.25, 0.5, 1],
		},
	);
	for (const section of settingsSections) {
		const el = document.getElementById(sectionElementId(section.id));
		if (el) scrollSpyObserver.observe(el);
	}
	updateActiveSectionFromScroll();
}

$effect(() => {
	void loadPage();
});

$effect(() => {
	if (!browser || loading || error || !settingsMainEl) return;
	const main = settingsMainEl;
	bindScrollSpy(main);
	const hash = window.location.hash.replace(/^#/, "");
	if (isSettingsSection(hash)) {
		requestAnimationFrame(() => scrollToSection(hash, { smooth: false }));
	} else {
		updateActiveSectionFromScroll();
	}
	return () => {
		scrollSpyObserver?.disconnect();
		scrollSpyObserver = null;
		if (scrollSpyRaf) cancelAnimationFrame(scrollSpyRaf);
		scrollSpyRaf = 0;
	};
});
</script>

<svelte:head><title>Space settings — Cohub</title></svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
	<header class="flex h-[44px] shrink-0 items-center justify-between border-b border-border-subtle px-3 sm:px-4">
		<div class="flex min-w-0 items-center gap-3">
			<button
				type="button"
				class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
				aria-label="Back to space"
				onclick={() => {
					if (typeof window !== "undefined" && window.history.length > 1) {
						window.history.back();
						return;
					}
					void goto(buildSpaceLandingRoute(spaceId));
				}}
			>
				<ArrowLeft class="h-4 w-4" />
			</button>
			<div class="min-w-0 truncate text-[13px] font-medium text-text-primary">Space settings</div>
		</div>
		<a href={`/spaces/${spaceId}/settings/commerce`} class="inline-flex h-8 items-center justify-center gap-1.5 rounded-[5px] px-2.5 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"><PackagePlus class="h-3.5 w-3.5" /> Commerce</a>
	</header>

	<div class="flex min-h-0 flex-1 flex-col lg:flex-row">
		<!-- Section nav — desktop sidebar -->
		<nav class="hidden w-44 shrink-0 flex-col gap-[2px] border-r border-border-subtle px-2 py-3 lg:flex" aria-label="Settings sections">
			{#each settingsSections as section (section.id)}
				<a
					href={`#${section.id}`}
					class="flex items-center gap-2.5 rounded-[5px] px-2 py-2 text-left text-[13px] transition-colors duration-100 {activeSection === section.id ? 'bg-bg-active font-medium text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
					onclick={(event) => handleSectionNavClick(event, section.id)}
				>
					<section.icon class="h-[15px] w-[15px] shrink-0" />
					<span class="truncate">{section.label}</span>
				</a>
			{/each}
		</nav>

		<!-- Section nav — mobile tabs -->
		<div class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border-subtle px-3 py-1.5 lg:hidden" role="navigation" aria-label="Settings sections">
			{#each settingsSections as section (section.id)}
				<a
					href={`#${section.id}`}
					aria-current={activeSection === section.id ? 'location' : undefined}
					class="shrink-0 rounded-[5px] px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-100 {activeSection === section.id ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
					onclick={(event) => handleSectionNavClick(event, section.id)}
				>
					{section.label}
				</a>
			{/each}
		</div>

		<main bind:this={settingsMainEl} class="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-7">
			<div class="mx-auto w-full max-w-2xl">
				{#if loading}
					<div aria-hidden="true">
						<div class="border-b border-border-subtle pb-5">
							<div class="h-5 w-24 rounded bg-bg-hover-strong"></div>
							<div class="mt-2 h-3.5 w-52 rounded bg-bg-hover-strong"></div>
						</div>
						<div class="space-y-3 py-6">
							<div class="h-9 w-full rounded-[5px] bg-bg-hover-strong"></div>
							<div class="h-9 w-full rounded-[5px] bg-bg-hover-strong"></div>
							<div class="h-20 w-full rounded-[5px] bg-bg-hover-strong"></div>
						</div>
					</div>
				{:else if error}
					<div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">{error}</div>
				{:else}
					<div class="pb-10">
						<!-- ════════ Profile ════════ -->
						<section id={sectionElementId("profile")} class="scroll-mt-6">
						<div class="border-b border-border-subtle pb-5">
							<h1 class="text-[18px] font-semibold tracking-tight text-text-primary">Profile</h1>
							<p class="mt-1 text-[13px] leading-5 text-text-tertiary">Public identity of this space.</p>
						</div>

						<div class="flex items-start gap-4 py-6">
							<div class="flex w-16 shrink-0 flex-col items-center gap-1.5">
								{#if canEditSpaceProfile}
									<label class="group relative h-14 w-14 cursor-pointer overflow-hidden rounded-full border border-border-subtle bg-bg-hover-strong transition-colors hover:border-brand/50 focus-within:border-brand/50" title="Change space avatar" aria-label="Change space avatar">
										<SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} size="lg" class="h-full w-full rounded-full border-0 shadow-none" />
										<span class="absolute inset-0 flex items-center justify-center bg-overlay-scrim-strong opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
											{#if spaceAvatarUploading}<Loader2 class="h-4 w-4 animate-spin text-overlay-control-text" />{:else}<Upload class="h-4 w-4 text-overlay-control-text" />{/if}
										</span>
										<input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" disabled={spaceAvatarUploading} onchange={handleSpaceAvatarFileChange} />
									</label>
									<label class="inline-flex cursor-pointer items-center gap-1 rounded-[4px] px-1 py-0.5 text-[11px] leading-none text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary {spaceAvatarUploading ? 'pointer-events-none opacity-50' : ''}">
										{#if spaceAvatarUploading}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Upload class="h-3 w-3" />{/if}
										<span>{space?.publicProfile?.avatarUrl ? "Change" : "Upload"}</span>
										<input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" disabled={spaceAvatarUploading} onchange={handleSpaceAvatarFileChange} />
									</label>
								{:else}
									<SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} size="lg" class="h-14 w-14 rounded-full" />
								{/if}
							</div>

							<div class="min-w-0 flex-1 pt-0.5">
								<!-- Name -->
								{#if renamingSpace && canEditSpaceProfile}
									<div class="flex min-w-0 items-center gap-2">
										<input type="text" bind:value={renameInput} disabled={renameSaving} aria-label="Space name" class="min-w-0 flex-1 rounded-[5px] border border-brand/40 bg-bg-input px-2.5 py-1.5 text-[15px] font-medium text-text-primary transition-colors focus:outline-none disabled:opacity-60" onkeydown={(event) => { if (event.key === 'Enter' && !renameSaving && !isComposingKeyboardEvent(event)) { event.preventDefault(); const trimmed = renameInput.trim(); if (trimmed && trimmed !== space?.name) void handleRenameSpace(trimmed); else { renamingSpace = false; renameError = ''; } } if (event.key === 'Escape' && !renameSaving) { renamingSpace = false; renameError = ''; } }} />
										<button type="button" class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title="Save name" disabled={renameSaving} onclick={() => { const trimmed = renameInput.trim(); if (trimmed && trimmed !== space?.name) void handleRenameSpace(trimmed); else { renamingSpace = false; renameError = ''; } }}>{#if renameSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}</button>
										<button type="button" class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title="Cancel" disabled={renameSaving} onclick={() => { renamingSpace = false; renameError = ''; }}><X class="h-3.5 w-3.5" /></button>
									</div>
								{:else if canEditSpaceProfile}
									<button type="button" onclick={() => { renameInput = space?.name ?? ''; renamingSpace = true; renameError = ''; }} class="group/edit -ml-1 flex max-w-full items-center gap-1.5 rounded-[5px] px-1 py-0.5 text-left transition-colors hover:bg-bg-hover" title="Rename space"><span class="min-w-0 truncate text-[15px] font-medium text-text-primary group-hover/edit:text-brand">{space?.name || space?.title || spaceId}</span><Pencil class="h-3 w-3 shrink-0 text-text-placeholder opacity-0 transition-opacity group-hover/edit:opacity-100" /></button>
								{:else}
									<h2 class="min-w-0 truncate text-[15px] font-medium text-text-primary">{space?.name || space?.title || spaceId}</h2>
								{/if}
								{#if renameError}<p class="mt-1 text-[11px] text-error-soft">{renameError}</p>{/if}

								<!-- ID -->
								<div class="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-text-tertiary">
									<span class="shrink-0 uppercase tracking-wider">ID</span>
									<code class="min-w-0 truncate font-mono" title={spaceId}>{formatCompactId(spaceId)}</code>
									<button type="button" onclick={() => void copySpaceId()} class="shrink-0 rounded-[4px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary" title="Copy space ID">
										{#if copiedSpaceId}<Check class="h-3 w-3 text-status-running" />{:else}<Copy class="h-3 w-3" />{/if}
									</button>
								</div>

								<!-- URL -->
								<div class="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-text-tertiary">
									<span class="shrink-0 uppercase tracking-wider">URL</span>
									{#if editingSpaceSlug && canEditSpaceProfile}
										<div class="flex min-w-0 flex-1 items-center gap-1.5">
											<div class="flex min-w-0 flex-1 items-center rounded-[5px] border border-brand/40 bg-bg-input px-2 py-1"><span class="shrink-0 font-mono {getSpaceOwnerUsername(space) ? 'text-text-tertiary' : 'text-text-placeholder'}">/{getSpaceOwnerUsername(space) || 'username'}/</span><input aria-label="Space slug" bind:value={spaceSlugDraft} placeholder="my-space" maxlength="80" onkeydown={handleSpaceSlugKeydown} disabled={spaceSlugSaving} class="min-w-0 flex-1 bg-transparent font-mono text-text-primary placeholder:text-text-placeholder focus:outline-none" /></div>
											<button type="button" onclick={() => void saveSpaceSlug()} disabled={spaceSlugSaving} class="shrink-0 rounded-[4px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title="Save slug">{#if spaceSlugSaving}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Check class="h-3 w-3" />{/if}</button>
											<button type="button" onclick={cancelSpaceSlugEdit} disabled={spaceSlugSaving} class="shrink-0 rounded-[4px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title="Cancel"><X class="h-3 w-3" /></button>
										</div>
									{:else}
										{#if getSpacePublicPath(space)}
											<button type="button" onclick={() => void copySpacePublicLink()} class="inline-flex min-w-0 items-center gap-1 truncate font-mono transition-colors hover:text-text-secondary" title="Copy public URL"><span class="min-w-0 truncate">{getSpacePublicPath(space)}</span>{#if copiedSpaceSlugLink}<Check class="h-3 w-3 shrink-0 text-status-running" />{:else}<Copy class="h-3 w-3 shrink-0" />{/if}</button>
										{:else if getSpaceSlug(space)}
											<code class="min-w-0 truncate font-mono"><span class="text-text-placeholder">/username/</span>{getSpaceSlug(space)}</code>
										{:else}
											<span class="text-text-placeholder">Not set</span>
										{/if}
										{#if canEditSpaceProfile}
											<button type="button" onclick={beginSpaceSlugEdit} class="shrink-0 rounded-[4px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary" title="Edit slug"><Pencil class="h-3 w-3" /></button>
										{/if}
									{/if}
								</div>
								{#if spaceSlugError}<p class="mt-1 text-[11px] text-error-soft break-words">{spaceSlugError}</p>{/if}
								{#if getSpacePrettyUrlHint(space) && !editingSpaceSlug}<p class="mt-1 text-[11px] leading-4 text-text-placeholder">{getSpacePrettyUrlHint(space)}</p>{/if}
							</div>
						</div>

						<!-- Description -->
						<div class="border-t border-border-subtle py-6">
							<label class="block text-[13px] font-medium text-text-primary" for="space-description">Description</label>
							<textarea id="space-description" bind:value={spaceDescriptionDraft} rows="3" maxlength="2000" disabled={!canEditSpaceProfile || spaceDescriptionSaving} onkeydown={handleDescriptionKeydown} class="mt-2 w-full resize-y rounded-[5px] border border-border-subtle bg-bg-input px-2.5 py-2 text-[13px] leading-5 text-text-primary placeholder:text-text-placeholder transition-colors focus:border-brand/40 focus:outline-none disabled:opacity-60" placeholder="What is this space for? Shown on the public page."></textarea>
							{#if canEditSpaceProfile}
								<div class="mt-3">
									<button type="button" onclick={() => void saveSpaceDescription()} disabled={spaceDescriptionSaving || spaceDescriptionDraft.trim() === (space?.description ?? '').trim()} class="inline-flex h-8 items-center justify-center gap-1.5 rounded-[5px] bg-brand px-3 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50">{#if spaceDescriptionSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" /> Saving…{:else}Save{/if}</button>
								</div>
							{/if}
							{#if spaceProfileError}<p class="mt-2 text-[12px] text-error-soft break-words">{spaceProfileError}</p>{/if}
						</div>
						</section>

						<!-- ════════ Access ════════ -->
						<section id={sectionElementId("access")} class="scroll-mt-6 border-t border-border-subtle pt-10">
						<div class="flex items-start justify-between gap-3 border-b border-border-subtle pb-5">
							<div class="min-w-0">
								<h1 class="text-[18px] font-semibold tracking-tight text-text-primary">Access</h1>
								<p class="mt-1 text-[13px] leading-5 text-text-tertiary">Who can view and build here.</p>
							</div>
							<button type="button" onclick={() => { showInvitePanel = true; inviteCreateError = ""; }} disabled={!canManageSpaceMembers} class="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[5px] border border-brand-border bg-brand-muted px-2.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand-muted-hover disabled:opacity-50"><Link class="h-3.5 w-3.5" /> Invite</button>
						</div>

						<!-- Default roles: settings rows -->
						<div class="divide-y divide-border-subtle border-b border-border-subtle">
							<div class="flex items-center justify-between gap-4 py-4">
								<div class="min-w-0">
									<div class="text-[13px] text-text-primary">Signed-in users</div>
									<p class="mt-0.5 text-[12px] leading-4 text-text-tertiary">Anyone signed in to Cohub.</p>
								</div>
								<select value={access?.signed_in_user ?? ""} disabled={!canManageSpaceMembers} onchange={(e) => { const value = (e.currentTarget as HTMLSelectElement).value as SpaceRole | ""; void setAccess({ signed_in_user: value || null }); }} class="h-8 w-28 shrink-0 rounded-[5px] border border-border-subtle bg-bg-input px-2 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none disabled:opacity-60" aria-label="Default role for signed-in users"><option value="">No access</option><option value="guest">Guest</option><option value="builder">Builder</option></select>
							</div>
							<div class="flex items-center justify-between gap-4 py-4">
								<div class="min-w-0">
									<div class="text-[13px] text-text-primary">Anonymous visitors</div>
									<p class="mt-0.5 text-[12px] leading-4 text-text-tertiary">Visitors without an account.</p>
								</div>
								<select value={access?.anonymous_user ?? ""} disabled={!canManageSpaceMembers} onchange={(e) => { const value = (e.currentTarget as HTMLSelectElement).value as SpaceRole | ""; void setAccess({ anonymous_user: value || null }); }} class="h-8 w-28 shrink-0 rounded-[5px] border border-border-subtle bg-bg-input px-2 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none disabled:opacity-60" aria-label="Default role for anonymous visitors"><option value="">No access</option><option value="guest">Guest</option></select>
							</div>
						</div>
						{#if accessError}<p class="mt-3 text-[12px] text-error-soft break-words">{accessError}</p>{/if}

						<!-- Members -->
						<div class="py-6">
							<h2 class="text-[13px] font-medium text-text-primary">Members <span class="font-normal text-text-tertiary">· {members.length}</span></h2>
							<div class="mt-3 overflow-hidden rounded-md border border-border-subtle">
								<div class="divide-y divide-border-subtle">
									{#each members as member (member.userId)}
										<div class="flex items-center gap-3 px-3 py-2.5">
											<UserAvatar name={getMemberDisplayName(member)} avatarUrl={member.profile?.avatarUrl} size="sm" />
											<div class="min-w-0 flex-1">
												<div class="flex items-center gap-1.5">
													<span class="truncate text-[13px] font-medium text-text-primary">{getMemberDisplayName(member)}</span>
													{#if getMemberRoleIcon(member.role)}<span class="shrink-0 text-[11px]" title="Host">{getMemberRoleIcon(member.role)}</span>{/if}
												</div>
												<button type="button" onclick={() => { void copyMemberUuid(member); }} title="Copy user UUID" class="mt-0.5 inline-flex max-w-full items-center gap-1 font-mono text-[10px] text-text-placeholder transition-colors hover:text-text-secondary"><span class="min-w-0 truncate">{getMemberUuid(member)}</span>{#if copiedMemberUserId === member.userId}<Check class="h-3 w-3 shrink-0 text-status-running" />{/if}</button>
											</div>
											<select value={member.role} disabled={!canManageSpaceMembers || updatingMemberUserId === member.userId || removingMemberUserId === member.userId} onchange={(e) => { const role = (e.currentTarget as HTMLSelectElement).value as SpaceRole; void selectMemberRole(member.userId, member.role, role); }} class="h-8 w-24 shrink-0 rounded-[5px] border border-border-subtle bg-bg-input px-2 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none disabled:opacity-50" aria-label={`${getMemberDisplayName(member)} role`}>
												{#each memberRoleOptions as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
											</select>
											<button type="button" onclick={() => { void removeMember(member.userId); }} disabled={!canManageSpaceMembers || removingMemberUserId === member.userId} title="Remove member" class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft disabled:opacity-40">{#if removingMemberUserId === member.userId}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}</button>
										</div>
									{:else}
										<div class="px-3 py-4 text-center text-[12px] text-text-tertiary">No members yet.</div>
									{/each}
								</div>
								{#if canManageSpaceMembers}
									<div class="flex flex-col gap-2 border-t border-border-subtle bg-bg-header-alt px-3 py-2.5 sm:flex-row sm:items-center">
										<input type="text" bind:value={addingMemberUuid} placeholder="User UUID" onkeydown={(event) => { if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) { event.preventDefault(); void addMember(); } }} class="h-8 min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
										<div class="flex items-center gap-2">
											<select bind:value={addingMemberRole} class="h-8 w-24 rounded-[5px] border border-border-subtle bg-bg-input px-2 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none" aria-label="New member role">
												{#each memberRoleOptions as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
											</select>
											<button type="button" onclick={() => { void addMember(); }} disabled={savingMember || !addingMemberUuid.trim()} class="inline-flex h-8 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle bg-bg-input px-3 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50">{#if savingMember}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if} Add</button>
										</div>
									</div>
								{/if}
							</div>
							{#if addingMemberError}<p class="mt-2 text-[12px] text-error-soft break-words">{addingMemberError}</p>{/if}
						</div>

						<!-- Invite links -->
						<div class="border-t border-border-subtle py-6">
							<div class="flex items-center justify-between gap-3">
								<h2 class="text-[13px] font-medium text-text-primary">Invite links <span class="font-normal text-text-tertiary">· {invitations.filter((item) => item.status === 'active').length} active</span></h2>
								<button type="button" onclick={() => { void loadInvitations(); }} disabled={loadingInvitations} class="inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50"><RefreshCw class="h-3 w-3 {loadingInvitations ? 'animate-spin' : ''}" /> Refresh</button>
							</div>
							{#if inviteCreateNotice}<div class="mt-3 rounded-md border border-success-soft/30 bg-success-bg px-3 py-2 text-[12px] text-success-soft">{inviteCreateNotice}</div>{/if}
							{#if invitationsError}<div class="mt-3 rounded-md border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft break-words">{invitationsError}</div>{/if}
							{#if invitations.length === 0 && !loadingInvitations}
								<p class="mt-3 text-[12px] text-text-tertiary">No invite links.</p>
							{:else if invitations.length > 0}
								<div class="mt-3 divide-y divide-border-subtle rounded-md border border-border-subtle">
									{#each invitations as invitation (invitation.token)}
										<div class="flex items-center justify-between gap-3 px-3 py-2.5">
											<div class="min-w-0 flex-1">
												<div class="flex flex-wrap items-center gap-2">
													<span class="inline-flex rounded bg-brand-bg px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-brand-muted-fg">{invitation.role}</span>
													<span class="text-[11px] text-text-tertiary">{invitation.useCount} use{invitation.useCount !== 1 ? 's' : ''}{invitation.maxUses ? ` / ${invitation.maxUses}` : ''}</span>
												</div>
												<div class="mt-0.5 text-[10px] text-text-placeholder">{invitation.status === 'active' ? formatInviteExpiry(invitation.expiresInSeconds) : invitation.status === 'revoked' ? 'Revoked' : 'All uses exhausted'}</div>
											</div>
											{#if invitation.status === 'active'}
												<div class="flex shrink-0 items-center gap-0.5">
													<button type="button" title="Copy invite link" onclick={() => { void copyInviteLink(invitation.token); }} class="inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary">{#if copiedInviteToken === invitation.token}<Check class="h-3.5 w-3.5 text-status-running" />{:else}<Copy class="h-3.5 w-3.5" />{/if}</button>
													<button type="button" title="Revoke invite" onclick={() => { void revokeInvite(invitation.token); }} class="inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft"><Trash2 class="h-3.5 w-3.5" /></button>
												</div>
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						</div>
						</section>

						<!-- ════════ Environment ════════ -->
						<section id={sectionElementId("environment")} class="scroll-mt-6 border-t border-border-subtle pt-10">
						<div class="border-b border-border-subtle pb-5">
							<h1 class="text-[18px] font-semibold tracking-tight text-text-primary">Environment</h1>
							<p class="mt-1 text-[13px] leading-5 text-text-tertiary">What the agent sees inside the sandbox: env vars and mounted spaces.</p>
						</div>

						<!-- Env vars -->
						<div class="py-6">
							<h2 class="text-[13px] font-medium text-text-primary">Variables <span class="font-normal text-text-tertiary">· {env.length}</span></h2>
							<p class="mt-0.5 text-[12px] leading-5 text-text-tertiary">Available to every sandbox process.</p>
							<div class="mt-3 overflow-hidden rounded-md border border-border-subtle">
								<div class="divide-y divide-border-subtle">
									{#each env as item (item.name)}
										<div class="flex items-center gap-3 px-3 py-2">
											<code class="w-32 shrink-0 truncate font-mono text-[11px] text-text-primary sm:w-40" title={item.name}>{item.name}</code>
											<code class="min-w-0 flex-1 truncate font-mono text-[11px] text-text-tertiary">{revealedEnvNames.has(item.name) ? item.value : '••••••••'}</code>
											<button type="button" onclick={() => toggleEnvReveal(item.name)} class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary" title={revealedEnvNames.has(item.name) ? 'Hide value' : 'Reveal value'}>{#if revealedEnvNames.has(item.name)}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}</button>
											{#if canEditSpaceProfile}
												<button type="button" onclick={() => removeEnv(item.name)} class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft" title="Remove variable"><Trash2 class="h-3.5 w-3.5" /></button>
											{/if}
										</div>
									{:else}
										<div class="px-3 py-4 text-center text-[12px] text-text-tertiary">No variables.</div>
									{/each}
								</div>
								{#if canEditSpaceProfile}
									<div class="flex flex-col gap-2 border-t border-border-subtle bg-bg-header-alt px-3 py-2.5 sm:flex-row sm:items-center">
										<input bind:value={envName} placeholder="NAME" onkeydown={(event) => { if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) { event.preventDefault(); addEnv(); } }} class="h-8 w-full min-w-0 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none sm:w-40" />
										<input bind:value={envValue} placeholder="value" onkeydown={(event) => { if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) { event.preventDefault(); addEnv(); } }} class="h-8 min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
										<button type="button" onclick={addEnv} disabled={!envName.trim()} class="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle bg-bg-input px-3 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50"><Plus class="h-3.5 w-3.5" /> Add</button>
									</div>
								{/if}
							</div>
							{#if envError}<p class="mt-2 text-[12px] text-error-soft break-words">{envError}</p>{/if}
						</div>

						<!-- Mounted spaces -->
						<div class="border-t border-border-subtle py-6">
							<h2 class="text-[13px] font-medium text-text-primary">Mounted spaces <span class="font-normal text-text-tertiary">· {mods.length}</span></h2>
							<p class="mt-0.5 max-w-xl text-[12px] leading-5 text-text-tertiary">Mounted read-only at <code class="font-mono text-text-secondary">/mods/&lt;slug&gt;</code>. Changes restart the sandbox.</p>
							{#if shouldShowBaseModRecommendation && recommendedBaseMod && canManageSpaceMods}
								<div class="mt-3 flex flex-col gap-2 rounded-md border border-brand-border bg-brand-muted px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
									<div class="min-w-0">
										<div class="text-[12px] font-medium text-text-primary">{recommendedBaseMod.name} <span class="font-normal text-text-tertiary">— recommended</span></div>
										<div class="mt-0.5 break-all font-mono text-[10px] text-text-tertiary">/mods/{recommendedBaseMod.mountSlug}</div>
										<button type="button" onclick={() => { void copyModSpaceId(recommendedBaseMod.modSpaceId); }} title="Copy mod space ID" class="mt-0.5 inline-flex max-w-full items-center gap-1 font-mono text-[10px] text-text-placeholder transition-colors hover:text-text-secondary"><span class="min-w-0 truncate">{recommendedBaseMod.modSpaceId}</span>{#if copiedModSpaceId === recommendedBaseMod.modSpaceId}<Check class="h-3 w-3 shrink-0 text-status-running" />{/if}</button>
									</div>
									<button type="button" onclick={() => fillRecommendedMod(recommendedBaseMod)} class="inline-flex h-7 shrink-0 items-center justify-center rounded-[5px] border border-brand-border px-2.5 text-[11px] font-medium text-brand transition-colors hover:bg-brand-muted-hover">Use</button>
								</div>
							{/if}
							<div class="mt-3 overflow-hidden rounded-md border border-border-subtle">
								<div class="divide-y divide-border-subtle">
									{#each mods as mod (mod.id)}
										<div class="flex items-start gap-3 px-3 py-2.5">
											<div class="min-w-0 flex-1">
												<div class="flex flex-wrap items-center gap-2">
													<span class="truncate text-[13px] font-medium text-text-primary">{mod.name ?? mod.modSpaceName ?? mod.modSpaceId}</span>
													<span class="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider {mod.enabled ? 'bg-success-bg text-success-soft' : 'bg-bg-hover text-text-placeholder'}">{mod.enabled ? 'on' : 'off'}</span>
												</div>
												<div class="mt-0.5 break-all font-mono text-[10px] text-text-placeholder">{mod.mountPath}</div>
												<button type="button" onclick={() => { void copyModSpaceId(mod.modSpaceId); }} title="Copy mod space ID" class="mt-0.5 inline-flex max-w-full items-center gap-1 font-mono text-[10px] text-text-placeholder transition-colors hover:text-text-secondary"><span class="min-w-0 truncate">{mod.modSpaceId}</span>{#if copiedModSpaceId === mod.modSpaceId}<Check class="h-3 w-3 shrink-0 text-status-running" />{/if}</button>
												{#if canManageSpaceMods}
													<input value={mod.mountSlug} onblur={(event) => { const slug = (event.currentTarget as HTMLInputElement).value.trim(); if (slug !== mod.mountSlug) { void updateModMountSlug(mod, slug); } }} onkeydown={(event) => { if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) { event.preventDefault(); const slug = (event.currentTarget as HTMLInputElement).value.trim(); if (slug !== mod.mountSlug) { void updateModMountSlug(mod, slug); } } }} placeholder="mount slug" aria-label="Mount slug" class="mt-1.5 w-full max-w-[200px] rounded-[4px] border border-border-subtle bg-bg-input px-2 py-1 font-mono text-[11px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
												{/if}
											</div>
											{#if canManageSpaceMods}
												<div class="flex shrink-0 items-center gap-0.5">
													<button type="button" onclick={() => toggleMod(mod)} disabled={modUpdatingId === mod.id} class="inline-flex h-7 items-center rounded-[5px] px-2 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50">{mod.enabled ? 'Disable' : 'Enable'}</button>
													<button type="button" onclick={() => removeMod(mod)} disabled={modUpdatingId === mod.id} title="Remove mod" class="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft disabled:opacity-50"><Trash2 class="h-3.5 w-3.5" /></button>
												</div>
											{/if}
										</div>
									{:else}
										<div class="px-3 py-4 text-center text-[12px] text-text-tertiary">No mounted spaces.</div>
									{/each}
								</div>
								{#if canManageSpaceMods}
									<div class="flex flex-col gap-2 border-t border-border-subtle bg-bg-header-alt px-3 py-2.5">
										<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
											<input bind:value={modSpaceId} placeholder="Mod Space UUID" class="h-8 min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
											<div class="flex items-center gap-2">
												<input bind:value={modName} placeholder="Name (optional)" class="h-8 w-full min-w-0 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none sm:w-32" />
												<input bind:value={modMountSlug} placeholder="Slug (optional)" class="h-8 w-full min-w-0 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none sm:w-32" />
												<button type="button" onclick={addMod} disabled={modSaving || !modSpaceId.trim()} class="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle bg-bg-input px-3 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50">{#if modSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if} Add</button>
											</div>
										</div>
									</div>
								{/if}
							</div>
							{#if modError}<p class="mt-2 text-[12px] text-error-soft break-words">{modError}</p>{/if}
							{#if modRestartMessage}<div class="mt-3 rounded-md border border-success-soft/30 bg-success-bg px-3 py-2 text-[12px] text-success-soft">{modRestartMessage}</div>{/if}
						</div>
						</section>

						<!-- ════════ Channels ════════ -->
						<section id={sectionElementId("channels")} class="scroll-mt-6 border-t border-border-subtle pt-10">
						<div class="border-b border-border-subtle pb-5">
							<h1 class="text-[18px] font-semibold tracking-tight text-text-primary">Channels</h1>
							<p class="mt-1 text-[13px] leading-5 text-text-tertiary">Let this space send and receive messages on external platforms.</p>
						</div>

						<div class="py-6">
							<div class="overflow-hidden rounded-md border border-border-subtle">
								<div class="divide-y divide-border-subtle">
									{#each channels as binding (binding.id)}
										<div class="px-3 py-2.5">
											<div class="flex items-start justify-between gap-3">
												<div class="min-w-0 flex-1">
													<div class="flex min-w-0 flex-wrap items-center gap-2">
														<span class="min-w-0 truncate text-[13px] font-medium text-text-primary">{binding.channel?.provider ?? 'channel'} · {binding.channel?.name ?? binding.channelId}</span>
														<span class={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${channelHealthClass(binding.health?.state ?? "connecting")}`}>
															{channelHealthLabel(binding.health, { bound: true })}
														</span>
													</div>
													{#if channelHealthMessage(binding.health)}
														<p class="mt-1 text-[12px] leading-4 text-error-soft break-words" title={channelHealthDetail(binding.health) ?? undefined}>
															{channelHealthMessage(binding.health)}
															{#if channelHealthDetail(binding.health)}
																<span class="text-text-tertiary"> · {channelHealthDetail(binding.health)}</span>
															{/if}
														</p>
													{/if}
												</div>
												{#if canManageSpaceChannels}
													<button type="button" onclick={() => unbindChannel(binding.channelId)} class="inline-flex h-7 shrink-0 items-center rounded-[5px] px-2 text-[11px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft">Unbind</button>
												{/if}
											</div>
											<div class="mt-2"><ChannelModelPicker model={binding.config?.model ?? null} disabled={!canManageSpaceChannels} saving={savingChannelConfigIds.has(binding.id)} onSelect={(model) => saveChannelModel(binding, model)} /></div>
											{#if binding.channel?.provider === "discord"}
												{@const discordConfig = (binding.config ?? {}) as DiscordChannelConfig}
												<label class="mt-2 flex items-center gap-2 rounded-[5px] border border-border-subtle bg-bg-code px-2.5 py-2 text-[12px] text-text-secondary">
													<input
														type="checkbox"
														checked={discordConfig.inbound?.requireMentionInGuild ?? true}
														disabled={!canManageSpaceChannels || savingChannelConfigIds.has(binding.id)}
														onchange={(event) => saveDiscordRequireMention(binding, event.currentTarget.checked)}
														class="rounded-sm border-border-subtle bg-bg-input checked:bg-brand disabled:opacity-50"
													/>
													<span class="min-w-0">Require @mention in Discord server channels</span>
												</label>
											{:else if binding.channel?.provider === "feishu"}
												{@const feishuConfig = (binding.config ?? {}) as FeishuChannelConfig}
												<label class="mt-2 flex items-center gap-2 rounded-[5px] border border-border-subtle bg-bg-code px-2.5 py-2 text-[12px] text-text-secondary">
													<input
														type="checkbox"
														checked={feishuConfig.inbound?.requireMentionInGroup ?? true}
														disabled={!canManageSpaceChannels || savingChannelConfigIds.has(binding.id)}
														onchange={(event) => saveFeishuRequireMention(binding, event.currentTarget.checked)}
														class="rounded-sm border-border-subtle bg-bg-input checked:bg-brand disabled:opacity-50"
													/>
													<span class="min-w-0">Require @mention in Feishu groups</span>
												</label>
											{/if}
										</div>
									{:else}
										<div class="px-3 py-4 text-center text-[12px] text-text-tertiary">No channels bound. <a href="/settings/channels" class="text-text-secondary underline underline-offset-2 hover:text-text-primary">Manage channels</a></div>
									{/each}
								</div>
								{#if canManageSpaceChannels && allChannels.filter((ch) => !channels.some((binding) => binding.channelId === ch.id)).length > 0}
									<div class="flex flex-col gap-2 border-t border-border-subtle bg-bg-header-alt px-3 py-2.5 sm:flex-row sm:items-center">
										<select bind:value={selectedChannelId} class="h-8 min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none" aria-label="Channel to bind">
											<option value="">Select a channel…</option>
											{#each allChannels.filter((ch) => !channels.some((binding) => binding.channelId === ch.id)) as channel (channel.id)}<option value={channel.id}>{channel.provider} · {channel.name}</option>{/each}
										</select>
										<button type="button" onclick={bindChannel} disabled={!selectedChannelId} class="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle bg-bg-input px-3 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50"><Plus class="h-3.5 w-3.5" /> Bind</button>
									</div>
								{/if}
							</div>
							{#if channelError}<p class="mt-2 text-[12px] text-error-soft break-words">{channelError}</p>{/if}
						</div>
						</section>

						<!-- ════════ Sandbox ════════ -->
						<section id={sectionElementId("sandbox")} class="scroll-mt-6 border-t border-border-subtle pt-10">
						<div class="flex items-start justify-between gap-3 border-b border-border-subtle pb-5">
							<div class="min-w-0">
								<h1 class="text-[18px] font-semibold tracking-tight text-text-primary">Sandbox</h1>
								<p class="mt-1 text-[13px] leading-5 text-text-tertiary">Compute size, hibernation, and health.</p>
							</div>
							<button type="button" onclick={forceRecoverSandbox} disabled={!canManageSpaceSandbox || recoveringSandbox} class="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50">{#if recoveringSandbox}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if} Force recover</button>
						</div>

						<!-- Settings rows -->
						<div class="divide-y divide-border-subtle border-b border-border-subtle">
							<!-- Compute spec -->
							<div class="py-4">
								<div class="flex items-center justify-between gap-4">
									<div class="min-w-0">
										<div class="text-[13px] text-text-primary">Compute spec</div>
										<div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
											<span class="text-[12px] font-medium text-text-secondary">{getSandboxSpecLabel(sandboxSpec)}</span>
											<span class="font-mono text-[11px] text-text-tertiary">{getSandboxSpecSummary(sandboxSpec)}</span>
											{#if savingSandboxSpec}
												<Loader2 class="h-3 w-3 animate-spin text-text-tertiary" />
											{:else if sandboxSpecPendingRestart || (appliedSandboxSpec && appliedSandboxSpec !== sandboxSpec)}
												<span class="rounded-full bg-warning-bg px-2 py-0.5 text-[10px] font-medium text-warning-soft">Restart to apply</span>
												{#if canManageSpaceSandbox}
													<button type="button" onclick={forceRecoverSandbox} disabled={recoveringSandbox} class="inline-flex items-center gap-1 text-[11px] font-medium text-brand transition-colors hover:text-brand-hover disabled:opacity-50">{#if recoveringSandbox}<Loader2 class="h-3 w-3 animate-spin" />{:else}<RefreshCw class="h-3 w-3" />{/if} Restart now</button>
												{/if}
											{/if}
										</div>
									</div>
									<button type="button" onclick={() => (specPickerOpen = true)} disabled={!canManageSpaceSandbox} class="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle bg-bg-input px-3 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50"><Zap class="h-3.5 w-3.5" /> Change</button>
								</div>
								{#if sandboxSpecError}<p class="mt-1.5 text-[12px] text-error-soft break-words">{sandboxSpecError}</p>{/if}
								{#if sandboxSpecMessage}<p class="mt-1.5 text-[12px] text-success-soft">{sandboxSpecMessage}</p>{/if}
							</div>

							<!-- Hibernate policy -->
							<div class="py-4">
								<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
									<div class="min-w-0">
										<div class="text-[13px] text-text-primary">Hibernation</div>
										<p class="mt-0.5 text-[12px] leading-4 text-text-tertiary">Pause the sandbox when idle to free compute.</p>
									</div>
									<div class="flex shrink-0 items-center gap-2">
										<select bind:value={sandboxAutoDestroyMode} disabled={!canManageSpaceSandbox} class="h-8 rounded-[5px] border border-border-subtle bg-bg-input px-2 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none disabled:opacity-60" aria-label="Hibernate mode">
											<option value="idle">After idle</option>
											<option value="never">Never</option>
										</select>
										{#if sandboxAutoDestroyMode === "idle"}
											<input type="number" min="60" max="2592000" step="60" bind:value={sandboxIdleTtlSeconds} disabled={!canManageSpaceSandbox} class="h-8 w-24 rounded-[5px] border border-border-subtle bg-bg-input px-2 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none disabled:opacity-60" aria-label="Idle seconds" />
											<span class="text-[11px] text-text-tertiary">sec</span>
										{/if}
										<button type="button" onclick={saveSandboxConfig} disabled={!canManageSpaceSandbox || savingSandboxConfig} class="inline-flex h-8 items-center justify-center rounded-[5px] bg-brand px-3 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50">{savingSandboxConfig ? "Saving…" : "Save"}</button>
									</div>
								</div>
								{#if sandboxAutoDestroyMode === "idle"}<p class="mt-1.5 text-[11px] text-text-placeholder sm:text-right">{formatTtl(sandboxIdleTtlSeconds)} · max 30d</p>{/if}
								{#if sandboxConfigError}<p class="mt-1.5 text-[12px] text-error-soft">{sandboxConfigError}</p>{/if}
								{#if sandboxConfigMessage}<p class="mt-1.5 text-[12px] text-success-soft">{sandboxConfigMessage}</p>{/if}
							</div>
						</div>

						<!-- Health -->
						<div class="py-6">
							<h2 class="text-[13px] font-medium text-text-primary">Health</h2>
							<div class="mt-3 flex flex-wrap items-center gap-2">
								<span class={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${getSandboxStatusClass(sandbox?.status)}`}>{getSandboxLifecycleLabel(sandbox?.status)}</span>
								<span class={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${getSandboxStatusClass(sandbox?.runtimeStatus)}`}>{getSandboxRuntimeLabel(sandbox?.runtimeStatus)}</span>
								{#if sandbox?.stopReason}<span class="inline-flex max-w-full items-center rounded-full bg-bg-hover px-2 py-0.5 text-[11px] text-text-tertiary ring-1 ring-border-subtle"><span class="truncate">{sandbox.stopReason}</span></span>{/if}
							</div>
							<div class="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 text-[12px] sm:grid-cols-4">
								<div title={getSandboxActivityTitle()}><div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Activity</div><div class="mt-0.5 text-text-primary">{getSandboxActivityText()}</div></div>
								<div title={getSandboxHeartbeatTitle()}><div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Heartbeat</div><div class="mt-0.5 text-text-primary">{formatRelativeTime(sandbox?.lastHeartbeatAt)}</div></div>
								<div><div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Stopped</div><div class="mt-0.5 text-text-primary">{formatRelativeTime(sandbox?.stoppedAt)}</div></div>
								<div class="min-w-0"><div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Pod</div><div class="mt-0.5 min-w-0 truncate font-mono text-[11px] text-text-primary" title={sandbox?.podName ?? ''}>{sandbox?.podName ?? '—'}</div></div>
								<div class="col-span-2 min-w-0"><div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Desired image</div><div class="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-text-secondary">{sandbox?.desiredImage ?? '—'}</div></div>
								<div class="col-span-2 min-w-0"><div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Reported image</div><div class="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-text-secondary">{(sandbox?.reportedImageVersion ?? getSandboxMetaValue('imageVersion')) || '—'}</div></div>
							</div>
							{#if sandboxRecoveryMessage}<div class="mt-4 rounded-md border border-success-soft/30 bg-success-bg px-3 py-2 text-[12px] text-success-soft">{sandboxRecoveryMessage}</div>{/if}
							{#if sandboxRecoveryError}<div class="mt-4 rounded-md border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft break-words">{sandboxRecoveryError}</div>{/if}
						</div>
						</section>
					</div>
				{/if}
			</div>
		</main>
	</div>
</div>

<Sheet open={showInvitePanel} onClose={() => { showInvitePanel = false; }} maxWidth="400px">
	<div class="p-5 pb-safe">
		<div class="mb-4 flex items-start justify-between gap-3">
			<div>
				<h3 class="text-[15px] font-medium text-text-primary">Create invite link</h3>
				<p class="mt-1 text-[12px] text-text-tertiary">Share the link to grant access.</p>
			</div>
			<button type="button" onclick={() => { showInvitePanel = false; }} class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary" aria-label="Close"><X class="h-4 w-4" /></button>
		</div>
		{#if inviteCreateError}<div class="mb-3 rounded-md border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft break-words">{inviteCreateError}</div>{/if}
		<div class="space-y-3">
			<div><label class="mb-1.5 block text-[12px] text-text-tertiary" for="invite-role">Role</label><select id="invite-role" bind:value={inviteRole} class="h-9 w-full rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[13px] text-text-primary focus:border-brand/40 focus:outline-none"><option value="builder">Builder</option><option value="guest">Guest</option><option value="host">Host</option></select></div>
			<div><label class="mb-1.5 block text-[12px] text-text-tertiary" for="invite-ttl">Valid for</label><select id="invite-ttl" bind:value={inviteTtlDays} class="h-9 w-full rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[13px] text-text-primary focus:border-brand/40 focus:outline-none"><option value={1}>1 day</option><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option></select></div>
			<div><label class="mb-1.5 block text-[12px] text-text-tertiary" for="invite-max-uses">Max uses <span class="text-text-placeholder">(0 = unlimited)</span></label><input id="invite-max-uses" type="number" bind:value={inviteMaxUses} min="0" max="10000" step="1" class="h-9 w-full rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[13px] text-text-primary focus:border-brand/40 focus:outline-none" /></div>
		</div>
		<div class="mt-5 flex justify-end gap-2">
			<button type="button" onclick={() => { showInvitePanel = false; }} class="inline-flex h-9 items-center rounded-[5px] px-3 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary">Cancel</button>
			<button type="button" onclick={() => { void createInvite(); }} disabled={creatingInvite} class="inline-flex h-9 items-center gap-1.5 rounded-[5px] bg-brand px-4 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50">{#if creatingInvite}<Loader2 class="h-3.5 w-3.5 animate-spin" /> Creating…{:else}<Link class="h-3.5 w-3.5" /> Create link{/if}</button>
		</div>
	</div>
</Sheet>

<SandboxSpecPicker
	open={specPickerOpen}
	currentSpec={sandboxSpec}
	appliedSpec={appliedSandboxSpec}
	allowedSpec={allowedSandboxSpec}
	specs={sandboxSpecs}
	onClose={() => (specPickerOpen = false)}
	onSelect={saveSandboxSpec}
	onUpgrade={openSandboxSpecUpgrade}
/>
