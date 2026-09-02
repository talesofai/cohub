import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError, type CohubHttpClient } from "@neta-art/cohub";
import { checkAppTarget } from "../src/app-target.js";

const httpError = (status: number, code: string) => new HttpError(code, status, { code });

function clientWithTree(entries: Array<{ path: string; type: "file" | "dir" | "symlink" }>): CohubHttpClient {
  return {
    space: () => ({
      files: {
        list: async () => ({ path: "", entries }),
      },
    }),
  } as unknown as CohubHttpClient;
}

test("checkAppTarget accepts an existing file and directory target", async () => {
  const client = clientWithTree([
    { path: "index.html", type: "file" },
    { path: "dist", type: "dir" },
  ]);
  assert.equal(await checkAppTarget(client, "space-1", { targetType: "file", targetRef: "index.html" }), null);
  assert.equal(await checkAppTarget(client, "space-1", { targetType: "directory", targetRef: "dist" }), null);
});

test("checkAppTarget normalizes ./ and trailing slashes before comparing", async () => {
  const client = clientWithTree([{ path: "dist", type: "dir" }]);
  assert.equal(await checkAppTarget(client, "space-1", { targetType: "directory", targetRef: "./dist/" }), null);
});

test("checkAppTarget reports missing targets", async () => {
  const client = clientWithTree([]);
  const failure = await checkAppTarget(client, "space-1", { targetType: "directory", targetRef: "dist" });
  assert.deepEqual(failure, {
    status: 404,
    code: "path_not_found",
    message: '"dist" does not exist in the Space workspace',
  });
});

test("checkAppTarget reports node type mismatches", async () => {
  const fileClient = clientWithTree([{ path: "dist", type: "file" }]);
  assert.deepEqual(
    await checkAppTarget(fileClient, "space-1", { targetType: "directory", targetRef: "dist" }),
    { status: 400, code: "not_a_directory", message: '"dist" is a file, but the publish target must be a directory' },
  );
  const dirClient = clientWithTree([{ path: "page.html", type: "dir" }]);
  assert.deepEqual(
    await checkAppTarget(dirClient, "space-1", { targetType: "file", targetRef: "page.html" }),
    { status: 400, code: "not_a_file", message: '"page.html" is a directory, but the publish target must be a file' },
  );
});

test("checkAppTarget treats a missing parent directory as a missing target", async () => {
  const client = {
    space: () => ({
      files: {
        list: async () => {
          throw httpError(404, "path_not_found");
        },
      },
    }),
  } as unknown as CohubHttpClient;
  const failure = await checkAppTarget(client, "space-1", { targetType: "directory", targetRef: "apps/world-stage/dist" });
  assert.equal(failure?.code, "path_not_found");
});

test("checkAppTarget stays silent on preflight failures other than a missing parent", async () => {
  const client = {
    space: () => ({
      files: {
        list: async () => {
          throw new Error("network down");
        },
      },
    }),
  } as unknown as CohubHttpClient;
  assert.equal(await checkAppTarget(client, "space-1", { targetType: "directory", targetRef: "dist" }), null);
});

test("checkAppTarget passes an empty target (workspace root)", async () => {
  assert.equal(await checkAppTarget(clientWithTree([]), "space-1", { targetType: "directory", targetRef: "" }), null);
});
