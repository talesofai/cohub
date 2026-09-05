<script lang="ts">
import {
	AlertTriangle,
	Check,
	ChevronRight,
	Cloud,
	Laptop,
	LockKeyhole,
	RefreshCw,
	ShieldAlert,
	X,
} from "lucide-svelte";
import { floatNear, portal } from "$lib/actions/portal";
import type {
	WorkspaceReplicationReplica,
	WorkspaceReplicationSnapshot,
} from "./workspace-replication-controller.svelte";

type Props = {
	replicationState: WorkspaceReplicationSnapshot;
	onRefresh: () => void | Promise<void>;
};

let { replicationState, onRefresh }: Props = $props();
let open = $state(false);
let rootEl: HTMLDivElement | null = $state(null);
let refreshing = $state(false);

const localReplicas = $derived(
	replicationState.replicas.filter((replica) => replica.kind === "local"),
);
const canonicalId = $derived(
	replicationState.workspace?.canonicalSnapshotId ?? null,
);
const activeLease = $derived.by(() => {
	const lease = replicationState.lease;
	if (!lease) return null;
	const expiresAt = Date.parse(lease.expiresAt);
	return Number.isFinite(expiresAt) && expiresAt > Date.now() ? lease : null;
});
const hasConflict = $derived(
	replicationState.openConflictCount > 0 ||
		replicationState.workspace?.status === "conflicted" ||
		localReplicas.some((replica) => replica.status === "conflicted"),
);
const hasRuntimeError = $derived(
	replicationState.runtimes.some((runtime) => runtime.status === "error"),
);
const aggregateStatus = $derived.by(() => {
	if (hasConflict)
		return { key: "blocked", label: "Action needed", tone: "danger" } as const;
	if (replicationState.error)
		return { key: "error", label: "Unavailable", tone: "muted" } as const;
	if (hasRuntimeError)
		return {
			key: "runtime_error",
			label: "Runtime issue",
			tone: "danger",
		} as const;
	if (replicationState.loading && !replicationState.workspace)
		return { key: "loading", label: "Checking", tone: "muted" } as const;
	if (activeLease)
		return { key: "lease", label: "In use", tone: "info" } as const;
	if (
		localReplicas.some(
			(replica) =>
				replica.status === "syncing" ||
				replica.currentSnapshotId !== canonicalId ||
				replica.appliedSnapshotId !== canonicalId,
		)
	) {
		return { key: "syncing", label: "Syncing", tone: "warning" } as const;
	}
	if (replicationState.workspace?.status === "ready")
		return { key: "ready", label: "In sync", tone: "success" } as const;
	return { key: "preparing", label: "Preparing", tone: "muted" } as const;
});
const title = $derived(`Workspace replication: ${aggregateStatus.label}`);

function shortId(value: string | null) {
	if (!value) return "Not available";
	return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function replicaStatus(replica: WorkspaceReplicationReplica) {
	if (replica.status === "conflicted") return "Conflict";
	if (replica.status === "error") return "Error";
	if (
		canonicalId &&
		replica.appliedSnapshotId === canonicalId &&
		replica.currentSnapshotId === canonicalId &&
		replica.status === "ready"
	)
		return "In sync";
	if (
		replica.status === "syncing" ||
		replica.currentSnapshotId !== replica.appliedSnapshotId
	)
		return "Syncing";
	return replica.status === "attaching" ? "Preparing" : "Ready";
}

function runtimeProviderLabel(provider: string) {
	if (provider === "claude_code") return "Claude Code";
	if (provider === "codex") return "Codex";
	return "Pi";
}

function runtimeStatusLabel(status: string) {
	if (status === "ready") return "Ready";
	if (status === "busy") return "Busy";
	if (status === "connecting") return "Connecting";
	if (status === "error") return "Error";
	if (status === "revoked") return "Revoked";
	return "Offline";
}

async function refresh() {
	if (refreshing) return;
	refreshing = true;
	try {
		await onRefresh();
	} finally {
		refreshing = false;
	}
}

function closeOnOutside(event: PointerEvent) {
	if (!open || !rootEl) return;
	const target = event.target as Node | null;
	if (
		target &&
		(rootEl.contains(target) ||
			(target instanceof Element &&
				target.closest(".workspace-replication-popover")))
	)
		return;
	open = false;
}

function closeOnEscape(event: KeyboardEvent) {
	if (event.key === "Escape") open = false;
}

$effect(() => {
	if (localReplicas.length === 0) open = false;
});

$effect(() => {
	if (typeof document === "undefined") return;
	document.addEventListener("pointerdown", closeOnOutside, true);
	window.addEventListener("keydown", closeOnEscape);
	return () => {
		document.removeEventListener("pointerdown", closeOnOutside, true);
		window.removeEventListener("keydown", closeOnEscape);
	};
});
</script>

{#if localReplicas.length > 0}
	<div class="workspace-replication-root" bind:this={rootEl}>
		<button
			type="button"
			class="workspace-replication-trigger tone-{aggregateStatus.tone}"
			onclick={() => (open = !open)}
			aria-haspopup="dialog"
			aria-expanded={open}
			aria-label={title}
			title={title}
		>
			<span class="status-mark" aria-hidden="true">
				{#if aggregateStatus.key === "blocked"}
					<ShieldAlert class="h-3.5 w-3.5" />
				{:else if aggregateStatus.key === "lease"}
					<LockKeyhole class="h-3.5 w-3.5" />
				{:else if aggregateStatus.key === "syncing" || aggregateStatus.key === "loading"}
					<span class:spin={aggregateStatus.key === "loading"}><RefreshCw class="h-3.5 w-3.5" /></span>
				{:else if aggregateStatus.key === "ready"}
					<Check class="h-3.5 w-3.5" />
				{:else if aggregateStatus.key === "runtime_error"}
					<AlertTriangle class="h-3.5 w-3.5" />
				{:else}
					<Cloud class="h-3.5 w-3.5" />
				{/if}
			</span>
			<span class="status-label">{aggregateStatus.label}</span>
			{#if replicationState.openConflictCount > 0}
				<span class="conflict-count">{replicationState.openConflictCount}</span>
			{/if}
		</button>

		{#if open}
			<div class="workspace-replication-backdrop" aria-hidden="true" use:portal onclick={() => (open = false)}></div>
			<div
				class="workspace-replication-popover"
				role="dialog"
				aria-label="Workspace replication"
				use:floatNear={{
					getAnchor: () => rootEl,
					placement: "bottom-end",
					gap: 8,
					width: 360,
					zIndex: 90,
				}}
			>
				<header class="popover-header">
					<div>
						<div class="popover-kicker">Workspace</div>
						<div class="popover-title">{aggregateStatus.label}</div>
					</div>
					<button type="button" class="icon-button" onclick={() => (open = false)} aria-label="Close" title="Close">
						<X class="h-4 w-4" />
					</button>
				</header>

				<div class="summary-row tone-{aggregateStatus.tone}">
					<span class="summary-icon" aria-hidden="true">
						{#if hasConflict || hasRuntimeError}<AlertTriangle class="h-4 w-4" />{:else}<Cloud class="h-4 w-4" />{/if}
					</span>
					<div class="summary-copy">
						<strong>{replicationState.workspace?.status === "conflicted" ? "Resolve workspace conflicts" : aggregateStatus.label}</strong>
						<span>{replicationState.openConflictCount > 0 ? `${replicationState.openConflictCount} open conflict${replicationState.openConflictCount === 1 ? "" : "s"}` : activeLease ? `Writer: ${activeLease.holderKind}` : "Canonical state is available to Web and mobile"}</span>
					</div>
				</div>

				<div class="detail-list">
					<div class="detail-row"><span>Canonical</span><code>{shortId(canonicalId)}</code></div>
					<div class="detail-row"><span>Generation</span><strong>{replicationState.workspace?.generation ?? 0}</strong></div>
					{#if activeLease}
						<div class="detail-row"><span>Lease</span><strong>Active writer</strong></div>
					{/if}
				</div>

				<div class="replica-list" role="list" aria-label="Local replicas">
					{#each localReplicas as replica (replica.id)}
						<div class="replica-row" role="listitem">
							<div class="replica-icon" aria-hidden="true"><Laptop class="h-4 w-4" /></div>
							<div class="replica-copy">
								<strong>{replica.displayName || "Local workspace"}</strong>
								<span>{replicaStatus(replica)}</span>
							</div>
							<ChevronRight class="replica-chevron h-4 w-4" aria-hidden="true" />
						</div>
					{/each}
				</div>

				{#if replicationState.runtimes.length > 0}
					<div class="runtime-heading">ACP runtimes</div>
					<div class="replica-list" role="list" aria-label="Local ACP runtimes">
						{#each replicationState.runtimes as runtime (runtime.id)}
							<div class="replica-row" role="listitem">
								<div class="replica-icon" aria-hidden="true"><Laptop class="h-4 w-4" /></div>
								<div class="replica-copy">
									<strong>{runtime.displayName || `${runtimeProviderLabel(runtime.provider)} runtime`}</strong>
									<span>{runtimeProviderLabel(runtime.provider)} · {runtimeStatusLabel(runtime.status)}</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				{#if replicationState.error}
					<div class="error-row">{replicationState.error}</div>
				{/if}
				<footer class="popover-footer">
					<span class="updated-at">Updated {new Date(replicationState.workspace?.updatedAt ?? Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
					<button type="button" class="refresh-button" onclick={() => void refresh()} disabled={refreshing}>
						<span class:spin={refreshing}><RefreshCw class="h-3.5 w-3.5" /></span>
						<span>{refreshing ? "Refreshing" : "Refresh"}</span>
					</button>
				</footer>
			</div>
		{/if}
	</div>
{/if}

<style>
	.workspace-replication-root {
		position: relative;
		flex: 0 0 auto;
	}

	.workspace-replication-trigger {
		display: inline-flex;
		height: 32px;
		min-width: 32px;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		padding: 0 8px;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.workspace-replication-trigger:hover,
	.workspace-replication-trigger[aria-expanded="true"] {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.workspace-replication-trigger.tone-success { color: var(--success-soft); }
	.workspace-replication-trigger.tone-warning { color: var(--warning); }
	.workspace-replication-trigger.tone-danger { color: var(--danger); }
	.workspace-replication-trigger.tone-info { color: var(--accent); }

	.status-mark { display: inline-flex; align-items: center; justify-content: center; }
	.status-label { font-size: 12px; font-weight: 550; white-space: nowrap; }
	.conflict-count {
		display: inline-flex;
		min-width: 18px;
		height: 18px;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		background: color-mix(in srgb, var(--danger) 14%, transparent);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.workspace-replication-backdrop { position: fixed; inset: 0; z-index: -1; }
	.workspace-replication-popover {
		width: min(360px, calc(100vw - 24px));
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 9px;
		background: var(--bg-elevated);
		box-shadow: 0 18px 42px color-mix(in srgb, var(--overlay-scrim-strong) 18%, transparent);
		color: var(--text-primary);
	}
	.popover-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 13px 14px 11px;
		border-bottom: 1px solid var(--border-subtle);
	}
	.popover-kicker { color: var(--text-tertiary); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
	.popover-title { margin-top: 2px; font-size: 15px; font-weight: 650; }
	.icon-button, .refresh-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
	}
	.icon-button { width: 28px; height: 28px; }
	.icon-button:hover, .refresh-button:hover { background: var(--bg-hover); color: var(--text-primary); }
	.summary-row { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; background: color-mix(in srgb, var(--bg-hover) 42%, transparent); }
	.summary-row.tone-danger { background: color-mix(in srgb, var(--danger) 8%, transparent); }
	.summary-row.tone-warning { background: color-mix(in srgb, var(--warning) 8%, transparent); }
	.summary-icon { display: inline-flex; padding-top: 1px; color: currentColor; }
	.summary-copy { display: grid; gap: 2px; min-width: 0; }
	.summary-copy strong { font-size: 12px; font-weight: 650; }
	.summary-copy span { color: var(--text-secondary); font-size: 12px; line-height: 1.35; }
	.detail-list { padding: 8px 14px; border-bottom: 1px solid var(--border-subtle); }
	.detail-row { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; min-height: 25px; color: var(--text-secondary); font-size: 12px; }
	.detail-row strong { color: var(--text-primary); font-weight: 600; }
	.detail-row code { max-width: 210px; overflow: hidden; color: var(--text-tertiary); font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
	.runtime-heading { padding: 8px 14px 3px; color: var(--text-tertiary); font-size: 10px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; }
	.replica-list { padding: 5px 8px; }
	.replica-row { display: flex; align-items: center; gap: 9px; min-height: 48px; padding: 6px; border-radius: 6px; }
	.replica-row:hover { background: var(--bg-hover); }
	.replica-icon { display: inline-flex; color: var(--text-tertiary); }
	.replica-copy { display: grid; gap: 2px; min-width: 0; flex: 1; }
	.replica-copy strong { overflow: hidden; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
	.replica-copy span { overflow: hidden; color: var(--text-tertiary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
	.replica-chevron { color: var(--text-placeholder); }
	.error-row { margin: 0 14px 9px; border-radius: 6px; background: color-mix(in srgb, var(--danger) 8%, transparent); padding: 8px; color: var(--danger); font-size: 11px; line-height: 1.35; }
	.popover-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border-subtle); padding: 9px 14px; }
	.updated-at { color: var(--text-placeholder); font-size: 11px; }
	.refresh-button { min-height: 28px; padding: 0 7px; font-size: 11px; font-weight: 600; }
	.refresh-button:disabled { cursor: default; opacity: 0.65; }
	.spin { animation: workspace-replication-spin 900ms linear infinite; }
	@keyframes workspace-replication-spin { to { transform: rotate(360deg); } }
	@media (max-width: 640px) {
		.status-label { display: none; }
		.workspace-replication-trigger { width: 32px; padding: 0; }
	}
	@media (prefers-reduced-motion: reduce) {
		.spin { animation: none; }
	}
</style>
