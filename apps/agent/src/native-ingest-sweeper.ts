import { asc, inArray } from "drizzle-orm";
import { nativeAgentIngests } from "@cohub/db";
import { defaultJobRetention } from "@cohub/infra/bullmq";
import { db } from "./db.js";
import { agentTurnQueue, NATIVE_AGENT_INGEST_JOB_NAME } from "./queue.js";

export async function sweepNativeAgentIngests(limit = 100) {
  const rows = await db.select({
    id: nativeAgentIngests.id,
    spaceId: nativeAgentIngests.spaceId,
    replicaId: nativeAgentIngests.replicaId,
    attemptCount: nativeAgentIngests.attemptCount,
  }).from(nativeAgentIngests).where(inArray(nativeAgentIngests.status, [
    "uploaded",
    "verifying",
    "committed",
    "translating",
    "forking",
    "appending_jsonl",
    "projecting",
    "publishing_marker",
  ])).orderBy(asc(nativeAgentIngests.updatedAt)).limit(limit);

  const bucket = Math.floor(Date.now() / 15_000);
  for (const row of rows) {
    await agentTurnQueue.add(NATIVE_AGENT_INGEST_JOB_NAME, {
      ingestId: row.id,
      spaceId: row.spaceId,
      replicaId: row.replicaId,
    }, {
      jobId: `native-agent-ingest-sweep-${row.id}-${row.attemptCount}-${bucket}`,
      attempts: 3,
      backoff: { type: "fixed", delay: 1000 },
      ...defaultJobRetention,
    });
  }
  return rows.length;
}
