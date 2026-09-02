import assert from "node:assert/strict";
import test from "node:test";
import { applyEditsToContent, createEditTool, createWriteTool, type EditOperations, type WriteOperations } from "../runtime/tools/basic-tools.js";

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

test("edit tolerates line ending and trailing whitespace differences", () => {
  const content = "prefix  \r\nold  \r\nsuffix\t\r\n";
  const updated = applyEditsToContent(content, [{ oldText: "old\n", newText: "new\n" }], PATH);
  assert.equal(updated, "prefix  \r\nnew\r\nsuffix\t\r\n");
});

test("edit preserves a UTF-8 BOM whether oldText includes it or not", () => {
  assert.equal(
    applyEditsToContent("\uFEFFalpha\n", [{ oldText: "alpha", newText: "beta" }], PATH),
    "\uFEFFbeta\n",
  );
  assert.equal(
    applyEditsToContent("\uFEFFalpha\n", [{ oldText: "\uFEFFalpha", newText: "beta" }], PATH),
    "\uFEFFbeta\n",
  );
});

test("edit uses the same first line ending for mixed newline files", () => {
  const updated = applyEditsToContent("a\rb\n", [{ oldText: "a\nb", newText: "x\ny" }], PATH);
  assert.equal(updated, "x\ry\n");
});

test("edit rejects empty edits before touching the filesystem", async () => {
  let accesses = 0;
  let writes = 0;
  const tool = createEditTool(CWD, {
    operations: {
      async access() {
        accesses += 1;
      },
      async readFile() {
        throw new Error("readFile must not be called");
      },
      async writeFile() {
        writes += 1;
      },
    },
  });

  await assert.rejects(
    tool.execute("call-1", { path: PATH, edits: [] }),
    /edits must contain at least one replacement/,
  );
  assert.equal(accesses, 0);
  assert.equal(writes, 0);
});

test("edit caps high-frequency match diagnostics", () => {
  assert.throws(
    () => applyEditsToContent("a".repeat(2_000_000), [{ oldText: "a", newText: "b" }], PATH),
    /found 9\+ at lines \[1, 1, 1, 1, 1, 1, 1, 1, \.\.\.,?\]/,
  );
});

test("edit matches all replacements against the original snapshot", () => {
  assert.throws(
    () => applyEditsToContent("alpha\n", [
      { oldText: "alpha", newText: "beta" },
      { oldText: "beta", newText: "gamma" },
    ], PATH),
    /edits\[1\]\.oldText must match exactly one region.*found 0/,
  );
});

test("edit rejects overlapping replacements before writing", () => {
  assert.throws(
    () => applyEditsToContent("alpha\n", [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "alpha\n", newText: "ALPHA\n" },
    ], PATH),
    /edits\[0\] and edits\[1\] overlap/,
  );
});

test("edit keeps normalized duplicate matches ambiguous", () => {
  assert.throws(
    () => applyEditsToContent("alpha  \r\nalpha\t\r\n", [{ oldText: "alpha\n", newText: "x" }], PATH),
    /found 2 at lines \[1, 2\]/,
  );
});

test("edit reports match line numbers and a recovery instruction", () => {
  assert.throws(
    () => applyEditsToContent("alpha\nalpha\nbeta\n", [{ oldText: "alpha", newText: "x" }], PATH),
    /found 2 at lines \[1, 2\].*Add surrounding context/,
  );
  assert.throws(
    () => applyEditsToContent("alpha\nbeta\n", [{ oldText: "alpah", newText: "x" }], PATH),
    /found 0.*Re-read the file and retry/,
  );
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
