import type { WorkspaceStateUpdatedEvent } from "@cohub/protocol/realtime";
import { HttpError } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";

export type WorkspaceReplicationReplica = {
	id: string;
	kind: "cloud" | "local";
	status: string;
	displayName?: string | null;
	currentSnapshotId: string | null;
	appliedSnapshotId: string | null;
	lastCommonSnapshotId: string | null;
	lastSeenAt?: string | null;
	updatedAt: string;
	nativeMirror?: {
		status: string;
		provider: string | null;
		fidelity: string | null;
		completeness: string | null;
		lastSeenAt: string | null;
		lastMirroredTurnId: string | null;
	} | null;
};

export type WorkspaceReplicationWorkspace = {
	canonicalSnapshotId: string | null;
	cloudAppliedSnapshotId: string | null;
	generation: number;
	status: string;
	activeCycleId: string | null;
	lastWriterKind: string | null;
	updatedAt: string;
};

export type WorkspaceReplicationLease = {
	holderKind: string;
	epoch: number;
	baseSnapshotId: string | null;
	expiresAt: string;
	lastHeartbeatAt: string;
	maximumDurationAt: string | null;
	takeoverRequiresConfirmation: boolean;
	updatedAt: string;
};

export type WorkspaceReplicationSnapshot = {
	replicas: WorkspaceReplicationReplica[];
	workspace: WorkspaceReplicationWorkspace | null;
	lease: WorkspaceReplicationLease | null;
	openConflictCount: number;
	loadedFor: string | null;
	loading: boolean;
	error: string | null;
};

type OverviewResponse = {
	replicas: Array<Record<string, unknown>>;
	workspace: Record<string, unknown> | null;
	lease: Record<string, unknown> | null;
	openConflictCount: number;
};

const asNullableString = (value: unknown) =>
	typeof value === "string" && value ? value : null;
const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

function parseReplica(
	value: Record<string, unknown>,
): WorkspaceReplicationReplica | null {
	const kind =
		value.kind === "cloud" || value.kind === "local" ? value.kind : null;
	if (
		!kind ||
		typeof value.id !== "string" ||
		typeof value.updatedAt !== "string"
	)
		return null;
	const mirror = asRecord(value.nativeMirror);
	return {
		id: value.id,
		kind,
		status: typeof value.status === "string" ? value.status : "unknown",
		displayName: asNullableString(value.displayName),
		currentSnapshotId: asNullableString(value.currentSnapshotId),
		appliedSnapshotId: asNullableString(value.appliedSnapshotId),
		lastCommonSnapshotId: asNullableString(value.lastCommonSnapshotId),
		lastSeenAt: asNullableString(value.lastSeenAt),
		updatedAt: value.updatedAt,
		nativeMirror: mirror
			? {
					status: typeof mirror.status === "string" ? mirror.status : "unknown",
					provider: asNullableString(mirror.provider),
					fidelity: asNullableString(mirror.fidelity),
					completeness: asNullableString(mirror.completeness),
					lastSeenAt: asNullableString(mirror.lastSeenAt),
					lastMirroredTurnId: asNullableString(mirror.lastMirroredTurnId),
				}
			: null,
	};
}

function parseWorkspace(
	value: Record<string, unknown> | null,
): WorkspaceReplicationWorkspace | null {
	if (!value || typeof value.updatedAt !== "string") return null;
	const generation =
		typeof value.generation === "number" &&
		Number.isSafeInteger(value.generation)
			? value.generation
			: 0;
	return {
		canonicalSnapshotId: asNullableString(value.canonicalSnapshotId),
		cloudAppliedSnapshotId: asNullableString(value.cloudAppliedSnapshotId),
		generation,
		status: typeof value.status === "string" ? value.status : "unknown",
		activeCycleId: asNullableString(value.activeCycleId),
		lastWriterKind: asNullableString(value.lastWriterKind),
		updatedAt: value.updatedAt,
	};
}

function parseLease(
	value: Record<string, unknown> | null,
): WorkspaceReplicationLease | null {
	if (
		!value ||
		typeof value.expiresAt !== "string" ||
		typeof value.updatedAt !== "string"
	)
		return null;
	return {
		holderKind:
			typeof value.holderKind === "string" ? value.holderKind : "unknown",
		epoch: typeof value.epoch === "number" ? value.epoch : 0,
		baseSnapshotId: asNullableString(value.baseSnapshotId),
		expiresAt: value.expiresAt,
		lastHeartbeatAt:
			typeof value.lastHeartbeatAt === "string"
				? value.lastHeartbeatAt
				: value.updatedAt,
		maximumDurationAt: asNullableString(value.maximumDurationAt),
		takeoverRequiresConfirmation: value.takeoverRequiresConfirmation === true,
		updatedAt: value.updatedAt,
	};
}

function parseOverview(
	value: OverviewResponse,
	spaceId: string,
): WorkspaceReplicationSnapshot {
	return {
		replicas: value.replicas
			.map(parseReplica)
			.filter(
				(replica): replica is WorkspaceReplicationReplica => replica !== null,
			),
		workspace: parseWorkspace(value.workspace),
		lease: parseLease(value.lease),
		openConflictCount: Number.isSafeInteger(value.openConflictCount)
			? value.openConflictCount
			: 0,
		loadedFor: spaceId,
		loading: false,
		error: null,
	};
}

export function createWorkspaceReplicationController(options: {
	getSpaceId: () => string;
	getPageVisible: () => boolean;
	getPageOnline: () => boolean;
	getPageMounted: () => boolean;
}) {
	let snapshot = $state<WorkspaceReplicationSnapshot>({
		replicas: [],
		workspace: null,
		lease: null,
		openConflictCount: 0,
		loadedFor: null,
		loading: false,
		error: null,
	});
	let requestToken = 0;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	function clearRefreshTimer() {
		if (!refreshTimer) return;
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}

	async function load() {
		const spaceId = options.getSpaceId();
		if (!spaceId || disposed) return;
		const token = ++requestToken;
		snapshot = { ...snapshot, loading: true, error: null };
		try {
			const value = await sdk.localAgent.listReplicas(spaceId);
			if (
				disposed ||
				token !== requestToken ||
				options.getSpaceId() !== spaceId
			)
				return;
			snapshot = parseOverview(value as unknown as OverviewResponse, spaceId);
		} catch (error) {
			if (
				disposed ||
				token !== requestToken ||
				options.getSpaceId() !== spaceId
			)
				return;
			// A Space without local-agent access is a normal state for existing
			// workspaces. Keep the header quiet instead of showing an error badge.
			const status = error instanceof HttpError ? error.status : null;
			snapshot = {
				...snapshot,
				replicas: status === 403 || status === 404 ? [] : snapshot.replicas,
				loadedFor: spaceId,
				loading: false,
				error:
					status === 403 || status === 404
						? null
						: error instanceof Error
							? error.message
							: "Workspace status unavailable",
			};
		}
		scheduleRefresh();
	}

	function applyRealtime(event: WorkspaceStateUpdatedEvent) {
		if (disposed || event.spaceId !== options.getSpaceId()) return;
		const payload = event.payload;
		const replica = payload.replica
			? parseReplica(payload.replica as unknown as Record<string, unknown>)
			: null;
		const existingReplica = replica
			? snapshot.replicas.find((item) => item.id === replica.id)
			: null;
		const replicaKnown = Boolean(existingReplica);
		const mergedReplica =
			replica && existingReplica
				? {
						...existingReplica,
						...replica,
						displayName: replica.displayName ?? existingReplica.displayName,
						lastSeenAt: replica.lastSeenAt ?? existingReplica.lastSeenAt,
						nativeMirror: replica.nativeMirror ?? existingReplica.nativeMirror,
					}
				: replica;
		const current =
			replicaKnown && mergedReplica
				? [
						...snapshot.replicas.filter((item) => item.id !== mergedReplica.id),
						mergedReplica,
					]
				: snapshot.replicas;
		snapshot = {
			...snapshot,
			replicas: current,
			workspace: parseWorkspace(
				payload.workspace as unknown as Record<string, unknown>,
			),
			lease:
				payload.lease === undefined
					? snapshot.lease
					: parseLease(
							payload.lease
								? (payload.lease as unknown as Record<string, unknown>)
								: null,
						),
			openConflictCount:
				typeof payload.openConflictCount === "number"
					? payload.openConflictCount
					: snapshot.openConflictCount,
			loadedFor: event.spaceId,
			loading: false,
			error: null,
		};
		if (replica && !replicaKnown) void load();
		else scheduleRefresh();
	}

	function scheduleRefresh() {
		clearRefreshTimer();
		if (
			disposed ||
			!options.getPageMounted() ||
			!options.getPageVisible() ||
			!options.getPageOnline()
		)
			return;
		const hasLocalReplica = snapshot.replicas.some(
			(replica) => replica.kind === "local",
		);
		if (!hasLocalReplica && snapshot.workspace?.status === "ready") return;
		const delay =
			snapshot.workspace?.status === "conflicted" ||
			snapshot.openConflictCount > 0
				? 5_000
				: 15_000;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			void load();
		}, delay);
	}

	function reset() {
		requestToken += 1;
		clearRefreshTimer();
		snapshot = {
			replicas: [],
			workspace: null,
			lease: null,
			openConflictCount: 0,
			loadedFor: null,
			loading: false,
			error: null,
		};
	}

	function dispose() {
		disposed = true;
		requestToken += 1;
		clearRefreshTimer();
	}

	return {
		get snapshot() {
			return snapshot;
		},
		load,
		applyRealtime,
		scheduleRefresh,
		reset,
		dispose,
	};
}
