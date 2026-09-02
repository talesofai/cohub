import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectUploadFiles, planUploadInput } from "../src/commands/spaces.js";

const tempDir = async () => mkdtemp(join(tmpdir(), "cohub-upload-"));

const writeFileTree = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
};

const relativePaths = async (input: string) =>
  (await planUploadInput(input)).map((file) => file.relativePath).sort();

test("directory input contributes its contents directly", async () => {
  const root = await tempDir();
  try {
    await writeFileTree(root, {
      "dist/index.html": "html",
      "dist/assets/app.js": "js",
    });
    assert.deepEqual(await relativePaths(join(root, "dist")), [
      "assets/app.js",
      "index.html",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trailing slash and relative input resolve to the same directory", async () => {
  const root = await tempDir();
  try {
    await writeFileTree(root, { "dist/index.html": "html" });
    assert.deepEqual(await relativePaths(join(root, "dist", "/")), ["index.html"]);
    assert.deepEqual(await relativePaths(join(root, "dist")), ["index.html"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file input keeps its own name", async () => {
  const root = await tempDir();
  try {
    await writeFileTree(root, { "dist/index.html": "html" });
    assert.deepEqual(await relativePaths(join(root, "dist", "index.html")), ["index.html"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mixed inputs do not collide or nest into each other", async () => {
  const root = await tempDir();
  try {
    await writeFileTree(root, {
      "dist/index.html": "html",
      "extra/notes.md": "notes",
    });
    assert.deepEqual(await collectUploadFiles([join(root, "dist"), join(root, "extra")]).then((files) => files.map((file) => file.relativePath).sort()), [
      "index.html",
      "notes.md",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("colliding relative paths across inputs fail instead of overwriting", async () => {
  const root = await tempDir();
  try {
    await writeFileTree(root, {
      "a/index.html": "a",
      "b/index.html": "b",
    });
    await assert.rejects(
      () => collectUploadFiles([join(root, "a"), join(root, "b")]),
      /Duplicate upload path "index\.html"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
