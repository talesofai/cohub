import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addSessionParticipantMeta,
  readSessionParticipantUserUuids,
} from "./session-meta.js";

describe("session participant identity migration", () => {
  it("replaces a legacy alias with canonical sub", () => {
    const meta = {
      participants: {
        version: 1,
        userUuids: ["legacy-uuid", "other-user"],
      },
    };

    const updated = addSessionParticipantMeta(meta, "logto-sub", ["legacy-uuid"]);
    assert.deepEqual(readSessionParticipantUserUuids(updated), ["other-user", "logto-sub"]);
  });

  it("does not duplicate an existing canonical participant", () => {
    const updated = addSessionParticipantMeta(
      { participants: { userUuids: ["logto-sub"] } },
      "logto-sub",
      ["legacy-uuid"],
    );
    assert.deepEqual(readSessionParticipantUserUuids(updated), ["logto-sub"]);
  });
});
