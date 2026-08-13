import assert from "node:assert/strict";
import test from "node:test";
import { createEditTool, createWriteTool, type EditOperations, type WriteOperations } from "../runtime/tools/basic-tools.js";

const CWD = "/workspace";
const PATH = "/workspace/a.ts";

test("edit delegates to applyEdits when the operations provide it", async () => {
  let applyCalls = 0;
  const tool = createEditTool(CWD, {
    operations: {
      async access() {},
      async readFile() {
        throw new Error("readFile must not be called when applyEdits is available");
      },
      async writeFile() {
        throw new Error("writeFile must not be called when applyEdits is available");
      },
      async applyEdits(absolutePath, edits) {
        applyCalls += 1;
        assert.equal(absolutePath, PATH);
        assert.deepEqual(edits, [{ oldText: "alpha", newText: "ALPHA" }]);
        return 1;
      },
    },
  });

  const result = await tool.execute("call-1", { path: PATH, edits: [{ oldText: "alpha", newText: "ALPHA" }] });
  assert.equal(applyCalls, 1);
  const text = (result.content as { type: string; text: string }[]).find((c) => c.type === "text")?.text;
  assert.match(text ?? "", /Applied 1 edit\(s\)/);
});

test("edit falls back to read-modify-write without applyEdits", async () => {
  let reads = 0;
  let writes = 0;
  const tool = createEditTool(CWD, {
    operations: {
      async access() {},
      async readFile() {
        reads += 1;
        return Buffer.from("alpha\nbeta\n", "utf8");
      },
      async writeFile(absolutePath, content) {
        writes += 1;
        assert.equal(absolutePath, PATH);
        assert.equal(content, "ALPHA\nbeta\n");
      },
    },
  });

  await tool.execute("call-1", { path: PATH, edits: [{ oldText: "alpha", newText: "ALPHA" }] });
  assert.equal(reads, 1);
  assert.equal(writes, 1);
});

test("write stays a plain write", async () => {
  let writes = 0;
  const tool = createWriteTool(CWD, {
    operations: {
      async mkdir() {},
      async writeFile(absolutePath, content) {
        writes += 1;
        assert.equal(absolutePath, PATH);
        assert.equal(content, "hello");
      },
    },
  });

  await tool.execute("call-1", { path: PATH, content: "hello" });
  assert.equal(writes, 1);
});

// Type-level sanity: minimal implementations still satisfy the interfaces.
const minimalEdit: EditOperations = {
  async readFile() {
    return Buffer.from("");
  },
  async writeFile() {},
  async access() {},
};
void minimalEdit;

const minimalWrite: WriteOperations = {
  async writeFile() {},
  async mkdir() {},
};
void minimalWrite;
