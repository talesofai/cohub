import assert from "node:assert/strict";
import { test } from "node:test";
import { publicUserProfile, type UserProfile } from "./user-profiles.js";

test("public user profiles omit internal identity and sync metadata", () => {
  const internalProfile: UserProfile = {
    userUuid: "viewer-1",
    logtoUserId: "logto-internal-id",
    username: "viewer",
    displayName: "Viewer",
    avatarUrl: "https://assets.example/avatar.webp",
    syncedAt: "2026-07-30T00:00:00.000Z",
  };
  const profile = publicUserProfile(internalProfile);

  assert.deepEqual(profile, {
    userUuid: "viewer-1",
    username: "viewer",
    displayName: "Viewer",
    avatarUrl: "https://assets.example/avatar.webp",
  });
  assert.equal("logtoUserId" in profile, false);
  assert.equal("syncedAt" in profile, false);
});
