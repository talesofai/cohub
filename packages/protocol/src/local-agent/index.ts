import { z } from "zod";

export const LOCAL_AGENT_PROTOCOL_VERSION = 1 as const;

export const LocalAgentDeviceStatusSchema = z.enum(["active", "revoked"]);
export type LocalAgentDeviceStatus = z.infer<typeof LocalAgentDeviceStatusSchema>;

export const LocalAgentWorkspaceModeSchema = z.enum(["two_way_safe", "one_way_to_cloud", "one_way_to_local", "handoff"]);
export type LocalAgentWorkspaceMode = z.infer<typeof LocalAgentWorkspaceModeSchema>;

export const LocalAgentPolicySchema = z.object({
  version: z.literal(LOCAL_AGENT_PROTOCOL_VERSION),
  workspaceMode: LocalAgentWorkspaceModeSchema,
}).strict();
export type LocalAgentPolicyV1 = z.infer<typeof LocalAgentPolicySchema>;
