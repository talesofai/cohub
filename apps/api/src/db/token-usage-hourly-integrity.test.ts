import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("nullable token usage dimensions upsert into one hourly row", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  if (!databaseUrl) return;

  const sql = postgres(databaseUrl, { prepare: false, max: 12 });
  const spaceId = randomUUID();
  const sessionId = randomUUID();
  const bucketStartAt = new Date("2026-07-16T00:00:00.000Z");
  try {
    const upsert = () => sql`
      insert into v2.token_usage_stats_hourly (
        bucket_start_at,
        user_id,
        space_id,
        session_id,
        provider,
        model,
        request_count,
        success_count,
        input_tokens,
        total_tokens,
        cost_total
      ) values (
        ${bucketStartAt},
        null,
        ${spaceId},
        ${sessionId},
        null,
        null,
        1,
        1,
        2,
        2,
        0.25
      )
      on conflict (bucket_start_at, user_id, space_id, session_id, provider, model)
      do update set
        request_count = token_usage_stats_hourly.request_count + excluded.request_count,
        success_count = token_usage_stats_hourly.success_count + excluded.success_count,
        input_tokens = token_usage_stats_hourly.input_tokens + excluded.input_tokens,
        total_tokens = token_usage_stats_hourly.total_tokens + excluded.total_tokens,
        cost_total = token_usage_stats_hourly.cost_total + excluded.cost_total
    `;

    await Promise.all(Array.from({ length: 32 }, upsert));
    const rows = await sql<{
      request_count: number;
      success_count: number;
      input_tokens: number;
      total_tokens: number;
      cost_total: string;
    }[]>`
      select request_count, success_count, input_tokens, total_tokens, cost_total
      from v2.token_usage_stats_hourly
      where space_id = ${spaceId} and session_id = ${sessionId}
    `;

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.request_count, 32);
    assert.equal(rows[0]?.success_count, 32);
    assert.equal(rows[0]?.input_tokens, 64);
    assert.equal(rows[0]?.total_tokens, 64);
    assert.equal(rows[0]?.cost_total, "8.00000000");
  } finally {
    await sql`
      delete from v2.token_usage_stats_hourly
      where space_id = ${spaceId} and session_id = ${sessionId}
    `;
    await sql.end();
  }
});
