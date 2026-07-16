import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("session message sequence allocation is atomic and idempotency-safe", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  if (!databaseUrl) return;

  const sql = postgres(databaseUrl, { prepare: false, max: 12 });
  const sessionId = randomUUID();
  const spaceId = randomUUID();
  try {
    await sql`
      insert into v2.spaces (id, user_uuid, name, storage_repo_name)
      values (${spaceId}, ${randomUUID()}, ${`space-${spaceId}`}, ${`repo-${spaceId}`})
    `;
    await sql`
      insert into v2.space_sessions (id, space_id, title)
      values (${sessionId}, ${spaceId}, 'sequence test')
    `;

    const append = (idempotencyKey: string) => sql`
      insert into v2.session_messages (
        session_id,
        role,
        content,
        sequence,
        idempotency_key
      ) values (
        ${sessionId},
        'user',
        '[]'::jsonb,
        v2.allocate_session_message_sequence(${sessionId}::uuid),
        ${idempotencyKey}
      )
      on conflict (session_id, idempotency_key) do nothing
      returning sequence
    `;

    await Promise.all(Array.from({ length: 32 }, (_, index) => append(`unique-${index}`)));
    const initial = await sql<{ sequence: number }[]>`
      select sequence
      from v2.session_messages
      where session_id = ${sessionId}
      order by sequence
    `;
    assert.deepEqual(initial.map((row) => row.sequence), Array.from({ length: 32 }, (_, index) => index + 1));

    await Promise.all(Array.from({ length: 16 }, () => append("same-request")));
    const duplicateRows = await sql<{ sequence: number }[]>`
      select sequence
      from v2.session_messages
      where session_id = ${sessionId} and idempotency_key = 'same-request'
    `;
    assert.equal(duplicateRows.length, 1);
    assert.equal(duplicateRows[0]?.sequence, 33);

    const [next] = await append("after-duplicates");
    assert.equal(next?.sequence, 34);
  } finally {
    try {
      await sql`delete from v2.space_sessions where id = ${sessionId}`;
      await sql`delete from v2.spaces where id = ${spaceId}`;
    } finally {
      await sql.end();
    }
  }
});
