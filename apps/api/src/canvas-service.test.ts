import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasServiceError, normalizeCanvasOps } from "./canvas-protocol.js";

test("version 2 canvas operations keep merge and metadata semantics explicit", () => {
  const operations = normalizeCanvasOps([
    {
      version: 2,
      type: "node.data.merge",
      payload: { nodeId: "text-1", data: { outputText: "new output" } },
    },
    {
      version: 2,
      type: "document.meta.patch",
      payload: { patch: { openTap: { schema: 1 } } },
    },
  ]);

  assert.deepEqual(operations, [
    {
      opId: undefined,
      version: 2,
      type: "node.data.merge",
      payload: { nodeId: "text-1", data: { outputText: "new output" } },
      inverse: undefined,
    },
    {
      opId: undefined,
      version: 2,
      type: "document.meta.patch",
      payload: { patch: { openTap: { schema: 1 } } },
      inverse: undefined,
    },
  ]);
});

test("new canvas operation semantics reject unversioned clients", () => {
  assert.throws(
    () => normalizeCanvasOps([{
      type: "node.data.merge",
      payload: { nodeId: "text-1", data: { outputText: "new output" } },
    }]),
    (error) => error instanceof CanvasServiceError
      && error.status === 400
      && error.message.includes("version 2"),
  );
});

test("legacy node.patch remains an explicit whole-field replacement", () => {
  const [operation] = normalizeCanvasOps([{
    type: "node.patch",
    payload: { nodeId: "text-1", patch: { data: { outputText: "replacement" } } },
  }]);

  assert.equal(operation?.version, 1);
  assert.deepEqual(operation?.payload, {
    nodeId: "text-1",
    patch: { data: { outputText: "replacement" } },
  });
});
