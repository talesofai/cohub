import type {
  WorkspaceManifestV1,
  WorkspaceSyncJobData,
} from "@cohub/protocol";
import type { Fetch, HttpTransport } from "../transport.js";

export type LocalAgentDevice = {
  id: string;
  userUuid: string;
  displayName: string;
  platform: string;
  daemonVersion: string | null;
  credentialVersion: number;
  status: "active" | "revoked";
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LocalAcpRuntimeRecord = {
  id: string;
  spaceId: string;
  deviceId: string;
  replicaId: string;
  userUuid: string;
  provider: "pi" | "codex" | "claude_code";
  displayName: string;
  providerVersion: string;
  adapterVersion: string;
  protocolVersion: number;
  capabilities: Record<string, unknown>;
  status: "offline" | "connecting" | "ready" | "busy" | "error" | "revoked";
  connectionEpoch: number;
  lastSeenAt: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LocalAgentAttachResponse = {
  replica: Record<string, unknown>;
  cloudReplica: Record<string, unknown>;
  workspace: Record<string, unknown>;
  workspacePolicy: Record<string, unknown>;
  integrationPolicy: Record<string, unknown>;
  bootstrapCycleId: string | null;
};

export type WorkspaceSnapshotPrepareInput = {
  snapshotId: string;
  replicaGeneration: number;
  parentSnapshotId?: string | null;
  baseCanonicalSnapshotId?: string | null;
  executionAttemptId?: string | null;
  leaseEpoch?: number | null;
  source?: string;
  manifest: WorkspaceManifestV1;
  manifestSha256?: string;
  manifestTransportSha256?: string | null;
  manifestTransportBytes?: number | null;
  blobs?: Array<{ path: string; sha256: string; size: number; contentType?: string | null }>;
};

export type WorkspaceSnapshotPrepareResponse = {
  snapshotId: string;
  status: string;
  manifestSha256: string;
  manifestBytes: number;
  manifestInline: boolean;
  manifestUpload: { objectKey: string; uploadUrl: string; headers: Record<string, string> | null; expiresAt: string } | null;
  blobs: Array<{ sha256: string; size: number; objectKey: string; status: string; uploadUrl: string | null; headers?: Record<string, string> | null; expiresAt?: string; ready: boolean }>;
  existing: boolean;
};

export type WorkspaceReplicaStateResponse = {
  replica: Record<string, unknown>;
  workspace: Record<string, unknown> | null;
  workspacePolicy: Record<string, unknown> | null;
  integrationPolicy: Record<string, unknown> | null;
  lease: Record<string, unknown> | null;
  openConflictCount: number;
};

export type WorkspaceReplicaOverviewResponse = {
  replicas: Array<Record<string, unknown>>;
  runtimes?: LocalAcpRuntimeRecord[];
  workspace: Record<string, unknown> | null;
  workspacePolicy: Record<string, unknown> | null;
  lease: Record<string, unknown> | null;
  openConflictCount: number;
};

export class LocalAgentApi {
  constructor(private readonly transport: HttpTransport) {}

  enroll(input: { displayName: string; platform: string; daemonVersion?: string | null }, customFetch?: Fetch) {
    return this.transport.request<{ device: LocalAgentDevice; accessToken: string; refreshToken: string }>("/api/local-agent/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      fetch: customFetch,
    });
  }

  listDevices(customFetch?: Fetch) {
    return this.transport.request<{ devices: LocalAgentDevice[] }>("/api/local-agent/devices", { fetch: customFetch });
  }

  issueToken(deviceId: string, refreshToken: string, customFetch?: Fetch) {
    return this.transport.request<{ deviceId: string; accessToken: string; expiresAt: string }>(`/api/local-agent/devices/${deviceId}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      fetch: customFetch,
    });
  }

  revokeDevice(deviceId: string, customFetch?: Fetch) {
    return this.transport.request<{ device: LocalAgentDevice }>(`/api/local-agent/devices/${deviceId}`, { method: "DELETE", fetch: customFetch });
  }

  registerRuntime(spaceId: string, input: {
    deviceId?: string;
    replicaId: string;
    provider: "pi" | "codex" | "claude_code";
    displayName: string;
    providerVersion?: string;
    adapterVersion?: string;
    capabilities?: Record<string, unknown>;
    protocolVersion?: number;
  }, customFetch?: Fetch) {
    return this.transport.request<LocalAcpRuntimeRecord>(`/api/local-agent/spaces/${spaceId}/runtimes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      fetch: customFetch,
    });
  }

  listRuntimes(spaceId: string, customFetch?: Fetch) {
    return this.transport.request<{ runtimes: LocalAcpRuntimeRecord[] }>(`/api/local-agent/spaces/${spaceId}/runtimes`, { fetch: customFetch });
  }

  getRuntime(spaceId: string, runtimeId: string, customFetch?: Fetch) {
    return this.transport.request<LocalAcpRuntimeRecord>(`/api/local-agent/spaces/${spaceId}/runtimes/${runtimeId}`, { fetch: customFetch });
  }

  revokeRuntime(spaceId: string, runtimeId: string, customFetch?: Fetch) {
    return this.transport.request<{ runtime: LocalAcpRuntimeRecord }>(`/api/local-agent/spaces/${spaceId}/runtimes/${runtimeId}`, { method: "DELETE", fetch: customFetch });
  }

  attach(spaceId: string, input: { deviceId?: string; rootFingerprint: string; displayName: string; capabilities?: Record<string, unknown>; protocolVersion?: number }, customFetch?: Fetch) {
    return this.transport.request<LocalAgentAttachResponse>(`/api/local-agent/spaces/${spaceId}/replicas/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      fetch: customFetch,
    });
  }

  snapshot(spaceId: string, replicaId: string, snapshotId: string, customFetch?: Fetch) {
    return this.transport.request<Record<string, unknown>>(`/api/local-agent/spaces/${spaceId}/replicas/${replicaId}/snapshots/${snapshotId}`, { fetch: customFetch });
  }

  acknowledgeApplied(spaceId: string, replicaId: string, snapshotId: string, generation: number, customFetch?: Fetch) {
    return this.transport.request<Record<string, unknown>>(`/api/local-agent/spaces/${spaceId}/replicas/${replicaId}/snapshots/${snapshotId}/applied`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generation }),
      fetch: customFetch,
    });
  }

  updatePolicy(spaceId: string, deviceId: string, input: Partial<{
    workspaceMode: "two_way_safe" | "one_way_to_cloud" | "one_way_to_local" | "handoff";
  }>, customFetch?: Fetch) {
    return this.transport.request<{ policy: Record<string, unknown> }>(`/api/local-agent/spaces/${spaceId}/devices/${deviceId}/policy`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      fetch: customFetch,
    });
  }

  listReplicas(spaceId: string, customFetch?: Fetch) {
    return this.transport.request<WorkspaceReplicaOverviewResponse>(`/api/local-agent/spaces/${spaceId}/replicas`, { fetch: customFetch });
  }

  state(spaceId: string, replicaId: string, customFetch?: Fetch) {
    return this.transport.request<WorkspaceReplicaStateResponse>(`/api/local-agent/spaces/${spaceId}/replicas/${replicaId}/state`, { fetch: customFetch });
  }

  conflicts(spaceId: string, replicaId?: string, customFetch?: Fetch) {
    const query = replicaId ? `?replicaId=${encodeURIComponent(replicaId)}` : "";
    return this.transport.request<{ conflicts: Array<Record<string, unknown>> }>(`/api/local-agent/spaces/${spaceId}/conflicts${query}`, { fetch: customFetch });
  }

  resolveConflict(spaceId: string, conflictId: string, resolution: "local" | "cloud" | "deleted" | "keep_managed", customFetch?: Fetch) {
    return this.transport.request<{ conflict: Record<string, unknown>; cycleId: string; queued: boolean }>(`/api/local-agent/spaces/${spaceId}/conflicts/${conflictId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution }),
      fetch: customFetch,
    });
  }

  prepareSnapshot(spaceId: string, replicaId: string, input: WorkspaceSnapshotPrepareInput, customFetch?: Fetch) {
    return this.transport.request<WorkspaceSnapshotPrepareResponse>(`/api/local-agent/spaces/${spaceId}/replicas/${replicaId}/snapshots/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      fetch: customFetch,
    });
  }

  commitSnapshot(spaceId: string, replicaId: string, snapshotId: string, customFetch?: Fetch) {
    return this.transport.request<{ snapshotId: string; status: string; manifestSha256: string; treeHash: string; cycleId: string | null }>(`/api/local-agent/spaces/${spaceId}/replicas/${replicaId}/snapshots/${snapshotId}/commit`, {
      method: "POST",
      fetch: customFetch,
    });
  }

  acquireLease(spaceId: string, input: { holderKind?: string; holderId: string; replicaId?: string | null; baseSnapshotId?: string | null; durationSeconds?: number }, customFetch?: Fetch) {
    return this.transport.request<Record<string, unknown>>(`/api/local-agent/spaces/${spaceId}/leases/acquire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      fetch: customFetch,
    });
  }

  heartbeatLease(spaceId: string, input: { holderKind: string; holderId: string; epoch: number; durationSeconds?: number }, customFetch?: Fetch) {
    return this.transport.request<Record<string, unknown>>(`/api/local-agent/spaces/${spaceId}/leases/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      fetch: customFetch,
    });
  }

  releaseLease(spaceId: string, input: { holderKind: string; holderId: string; epoch: number }, customFetch?: Fetch) {
    return this.transport.request<{ released: true; epoch: number }>(`/api/local-agent/spaces/${spaceId}/leases/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      fetch: customFetch,
    });
  }
}

export type { WorkspaceSyncJobData };
