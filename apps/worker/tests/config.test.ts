import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveNetaRouterBaseUrl } from "../src/config.js";

test("resolveNetaRouterBaseUrl defaults to the public router", () => {
  assert.equal(resolveNetaRouterBaseUrl(undefined), "https://router.neta.art");
  assert.equal(resolveNetaRouterBaseUrl(""), "https://router.neta.art");
});

test("resolveNetaRouterBaseUrl uses and normalizes the worker environment value", () => {
  assert.equal(
    resolveNetaRouterBaseUrl("  http://neta-router.newapi.svc.cluster.local///  "),
    "http://neta-router.newapi.svc.cluster.local",
  );
});
