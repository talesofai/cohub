import assert from "node:assert/strict";
import { test } from "node:test";
import { isGenerationModelPricing } from "./dist/generation/index.js";

test("generation pricing accepts fixed and ranged unit prices", () => {
  assert.equal(isGenerationModelPricing({ unit: "image", amount: 0.007 }), true);
  assert.equal(isGenerationModelPricing({ unit: "second", min: 0.07, max: 0.38 }), true);
  assert.equal(
    isGenerationModelPricing({ unit: "second", min: 0.126, max: 0.168, note: "std–pro" }),
    true,
  );
  assert.equal(isGenerationModelPricing({ unit: "1m_tokens", amount: 140 }), true);
});

test("generation pricing rejects malformed blocks", () => {
  const invalid = [
    null,
    "image",
    [],
    { unit: "token", amount: 1 },
    { unit: "image" },
    { unit: "image", amount: 1, min: 1, max: 2 },
    { unit: "image", amount: -1 },
    { unit: "image", min: 2, max: 1 },
    { unit: "image", min: Number.NaN },
    { unit: "image", amount: 1, note: 5 },
    { unit: "image", amount: 1, extra: true },
  ];

  for (const value of invalid) {
    assert.equal(isGenerationModelPricing(value), false, JSON.stringify(value));
  }
});
