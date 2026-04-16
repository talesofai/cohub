import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { spaceSandboxes } from "./db/schema-v2.js";
import { sessionsNamespace, config } from "./config.js";
import { k8sCoreApi } from "./k8s.js";
import { renderSandboxPodTemplate } from "./sandbox-template.js";
import type { SpaceSandboxStatus } from "@cohub/protocol";
import type { V1Pod } from "@kubernetes/client-node";

export const getSpaceSandboxBySpaceId = async (spaceId: string) => {
  const [sandbox] = await db
    .select()
    .from(spaceSandboxes)
    .where(eq(spaceSandboxes.spaceId, spaceId))
    .limit(1);

  return sandbox ?? null;
};

export const ensureSpaceSandbox = async (input: {
  spaceId: string;
  status?: SpaceSandboxStatus;
  podName?: string | null;
  meta?: Record<string, unknown> | null;
}) => {
  const [sandbox] = await db
    .insert(spaceSandboxes)
    .values({
      spaceId: input.spaceId,
      status: input.status ?? "pending",
      podName: input.podName ?? null,
      meta: input.meta ?? null,
    })
    .onConflictDoUpdate({
      target: spaceSandboxes.spaceId,
      set: {
        status: input.status ?? "pending",
        podName: input.podName ?? null,
        meta: input.meta ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!sandbox) throw new Error("Failed to ensure space sandbox");
  return sandbox;
};

export const updateSpaceSandbox = async (input: {
  spaceId: string;
  status?: SpaceSandboxStatus;
  podName?: string | null;
  lastHeartbeatAt?: Date | null;
  meta?: Record<string, unknown> | null;
}) => {
  const [sandbox] = await db
    .update(spaceSandboxes)
    .set({
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.podName !== undefined ? { podName: input.podName } : {}),
      ...(input.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: input.lastHeartbeatAt } : {}),
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
      updatedAt: new Date(),
    })
    .where(eq(spaceSandboxes.spaceId, input.spaceId))
    .returning();

  return sandbox ?? null;
};

const tryCreatePod = async (spaceId: string, pod: V1Pod) => {
  await k8sCoreApi.createNamespacedPod({
    namespace: sessionsNamespace,
    body: pod,
  });
  return { podName: `sandbox-${spaceId}` };
};

export const provisionSpaceInBackground = async (input: {
  spaceId: string;
  userUuid: string;
  workspaceRepoUrl?: string;
  workspaceGitUsername?: string;
  workspaceGitEmail?: string;
  extraEnv?: Array<{ name: string; value: string }>;
}) => {
  const podName = `sandbox-${input.spaceId}`;

  try {
    await updateSpaceSandbox({
      spaceId: input.spaceId,
      status: "provisioning",
      podName,
      meta: { provisioningStartedAt: new Date().toISOString() },
    });

    const pod = renderSandboxPodTemplate({
      SPACE_ID: input.spaceId,
      USER_ID: input.userUuid,
      REDIS_URL: config.redisUrl,
      LITELLM_API_KEY: config.litellmApiKey,
      ENV: config.env,
      WORKSPACE_REPO_URL: input.workspaceRepoUrl,
      WORKSPACE_GIT_USERNAME: input.workspaceGitUsername,
      WORKSPACE_GIT_EMAIL: input.workspaceGitEmail,
    }) as V1Pod;

    if (pod.spec?.containers?.[0]) {
      pod.spec.containers[0].env = [
        { name: "SPACE_ID", value: input.spaceId },
        { name: "REDIS_URL", value: config.redisUrl },
        { name: "ENV", value: config.env },
        { name: "WORKSPACE_DIR", value: "/workspace" },
        { name: "SESSIONS_DIR", value: "/sessions" },
        { name: "PUBLIC_URL_PREFIX", value: config.env === "prod" ? `https://public.cohub.run/r/${input.spaceId}` : `https://public.cohub.run/dev/r/${input.spaceId}` },
        { name: "AGENT_VERSION", value: config.sandboxAgentImage },
        { name: "LITELLM_API_KEY", value: config.litellmApiKey ?? "" },
        { name: "WORKSPACE_REPO_URL", value: input.workspaceRepoUrl ?? "" },
        { name: "WORKSPACE_GIT_USERNAME", value: input.workspaceGitUsername ?? "" },
        { name: "WORKSPACE_GIT_EMAIL", value: input.workspaceGitEmail ?? "" },
        { name: "INTERNAL_API_BASE_URL", value: config.env === "prod" ? "http://cohub-api.cohub.svc.cluster.local:8787" : "http://cohub-api-dev.cohub-dev.svc.cluster.local:8787" },
        ...(input.extraEnv ?? []),
      ];
    }

    await tryCreatePod(input.spaceId, pod);

    await updateSpaceSandbox({
      spaceId: input.spaceId,
      status: "ready",
      podName,
      meta: { lastReadyAt: new Date().toISOString() },
    });
  } catch (error) {
    await updateSpaceSandbox({
      spaceId: input.spaceId,
      status: "error",
      podName,
      meta: { lastError: error instanceof Error ? error.message : String(error) },
    }).catch(() => undefined);
  }
};
