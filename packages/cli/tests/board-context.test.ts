import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardClient } from "@neta-art/cohub";
import { mutateSemantic } from "../src/commands/boards/context.js";

const command = { type: "board.patch", patch: { title: "Updated" } } as const;
const conflict = Object.assign(new Error("version conflict"), { code: "VERSION_CONFLICT" });

function boardStub(mutate: () => Promise<unknown>, summary: () => Promise<{ board: { version: number } }>) {
  return { mutateSemantic: mutate, summary } as unknown as BoardClient;
}

test("an explicit base version rejects a conflict without retrying", async () => {
  let summaries = 0;
  let mutations = 0;
  const board = boardStub(
    async () => {
      mutations += 1;
      throw conflict;
    },
    async () => {
      summaries += 1;
      return { board: { version: 2 } };
    },
  );

  await assert.rejects(
    mutateSemantic(board, [command], { baseVersion: 1 }),
    (error) => error === conflict,
  );
  assert.equal(mutations, 1);
  assert.equal(summaries, 0);
});

test("an unpinned mutation retries once against the latest version", async () => {
  let summaries = 0;
  let mutations = 0;
  const board = boardStub(
    async () => {
      mutations += 1;
      if (mutations === 1) throw conflict;
      return { board: { version: 2 } } as never;
    },
    async () => {
      summaries += 1;
      return { board: { version: summaries === 1 ? 1 : 2 } };
    },
  );

  const result = await mutateSemantic(board, [command]);
  assert.deepEqual(result, { board: { version: 2 } });
  assert.equal(mutations, 2);
  assert.equal(summaries, 2);
});
