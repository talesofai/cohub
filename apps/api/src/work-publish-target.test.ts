import assert from "node:assert/strict";

const { hasSameWorkPublishTarget } = await import("./work-publish-target.js");

const target = {
  spaceId: "11111111-1111-4111-8111-111111111111",
  slug: "control-room",
  targetType: "directory",
  targetRef: "dist",
};
assert.equal(hasSameWorkPublishTarget(target, { ...target }), true);
assert.equal(hasSameWorkPublishTarget(target, { ...target, slug: "renamed" }), false);
assert.equal(hasSameWorkPublishTarget(target, { ...target, targetRef: "other" }), false);

console.log("api work publish target fencing checks passed");
