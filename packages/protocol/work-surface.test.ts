import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWorkComposerChipClear,
  buildWorkComposerChipSet,
  parseWorkComposerChipClear,
  parseWorkComposerChipSet,
  WORK_COMPOSER_CHIP_CONTENT_MAX_BYTES,
} from "./src/work-surface.js";

test("Work composer chip messages round-trip without changing content", () => {
  const chip = {
    key: "selection",
    label: "3 selected",
    content: "Selected records:\n- customer_123\n- customer_456",
  };

  assert.deepEqual(parseWorkComposerChipSet(buildWorkComposerChipSet(chip)), {
    protocol: "cohub.surface",
    version: 1,
    type: "composer.chip.set",
    chip,
  });
  assert.deepEqual(parseWorkComposerChipClear(buildWorkComposerChipClear(chip.key)), {
    protocol: "cohub.surface",
    version: 1,
    type: "composer.chip.clear",
    key: chip.key,
  });
});

test("Work composer chips reject empty, oversized, and malformed input", () => {
  const message = (chip: Record<string, unknown>) => ({
    protocol: "cohub.surface",
    version: 1,
    type: "composer.chip.set",
    chip,
  });

  assert.equal(parseWorkComposerChipSet(message({ key: "", label: "Item", content: "value" })), null);
  assert.equal(parseWorkComposerChipSet(message({ key: "item", label: " ", content: "value" })), null);
  assert.equal(parseWorkComposerChipSet(message({ key: "item", label: "Item", content: " " })), null);
  assert.equal(
    parseWorkComposerChipSet(
      message({
        key: "item",
        label: "Item",
        content: "x".repeat(WORK_COMPOSER_CHIP_CONTENT_MAX_BYTES + 1),
      }),
    ),
    null,
  );
});
