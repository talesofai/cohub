import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeTaskRunPricingForViewer } from "./task-run-privacy.js";

const generationRun = {
  taskType: "generation",
  userUuid: "viewer-1",
  payload: {
    data: {
      model: "image-model",
      modelDiscount: { multiplier: 0.5 },
    },
  },
  result: {
    output: [],
    billing: { amountUsd: 0.1 },
  },
};

describe("task run pricing privacy", () => {
  it("keeps pricing only for a real account owner", () => {
    assert.equal(
      sanitizeTaskRunPricingForViewer(generationRun, "viewer-1"),
      generationRun,
    );
  });

  it("strips pricing when a scoped principal represents the same UUID", () => {
    const sanitized = sanitizeTaskRunPricingForViewer(generationRun, null);
    assert.deepEqual(sanitized.payload, { data: { model: "image-model" } });
    assert.deepEqual(sanitized.result, { output: [] });
  });
});
