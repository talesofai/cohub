import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeGenerationBaseUrl } from "../src/config.js";

test("normalizeGenerationBaseUrl omits an unset or empty override", () => {
  assert.equal(normalizeGenerationBaseUrl(undefined), undefined);
  assert.equal(normalizeGenerationBaseUrl(""), undefined);
  assert.equal(normalizeGenerationBaseUrl("   "), undefined);
});

test("normalizeGenerationBaseUrl trims the configured override", () => {
  assert.equal(
    normalizeGenerationBaseUrl("  https://generation.example.com///  "),
    "https://generation.example.com",
  );
});
