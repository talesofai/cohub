import { sql } from "drizzle-orm";
import { sessionMessages, sessionTurns } from "@cohub/db";

/**
 * Native messages are projected before their JSONL commit marker is appended.
 * Keep them out of every product-facing REST query until the ingest's final
 * visibility transaction has completed. Ordinary CoHub messages have no native
 * ingest metadata and remain visible through the first branch.
 */
export const visibleSessionTurnPredicate = () => sql`(
  ${sessionTurns.meta}->>'nativeIngestId' is null
  or exists (
    select 1
    from v2.native_agent_ingests native_ingest
    where native_ingest.id::text = ${sessionTurns.meta}->>'nativeIngestId'
      and native_ingest.status = 'applied'
      and native_ingest.transcript_visibility = 'visible'
  )
)`;

export const visibleSessionMessagePredicate = () => sql`(
  ${sessionMessages.meta}->>'cohubNativeIngestId' is null
  or exists (
    select 1
    from v2.native_agent_ingests native_ingest
    where native_ingest.id::text = ${sessionMessages.meta}->>'cohubNativeIngestId'
      and native_ingest.status = 'applied'
      and native_ingest.transcript_visibility = 'visible'
  )
)`;
