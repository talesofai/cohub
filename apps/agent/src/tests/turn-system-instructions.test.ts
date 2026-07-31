import assert from "node:assert/strict";
import { test } from "node:test";
import { activateTurnSystemInstructions } from "../runtime/turn-system-instructions.js";

test("consecutive turns set and then clear request instructions", async () => {
  let current: string | null = null;
  const configured: Array<string | null> = [];
  const session = {
    async configureSystemInstructions(instructions?: string | null) {
      current = instructions ?? null;
      configured.push(current);
    },
  };

  const clearFirstTurn = await activateTurnSystemInstructions(
    session,
    "Only answer the first turn in JSON.",
  );
  assert.equal(current, "Only answer the first turn in JSON.");
  await clearFirstTurn();
  assert.equal(current, null);

  const clearSecondTurn = await activateTurnSystemInstructions(session, null);
  assert.equal(current, null);
  await clearSecondTurn();
  await clearSecondTurn();

  assert.deepEqual(configured, [
    "Only answer the first turn in JSON.",
    null,
    null,
    null,
  ]);
});
