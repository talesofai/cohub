import { createHash, randomUUID } from "node:crypto";
import { canonicalizeJson } from "@cohub/protocol/workspace-replication";

export function buildWorkspaceMutationOperationKey(
  kind: string,
  value: unknown,
  mutationId?: string,
) {
  const payloadHash = createHash("sha256").update(canonicalizeJson(value)).digest("hex");
  const requestIdentity = mutationId?.trim() || randomUUID();
  return `${kind}:${requestIdentity}:${payloadHash}`;
}
