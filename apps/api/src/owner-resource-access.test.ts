import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canBindGenerationToSession,
  canReadSessionResource,
  canReadTaskResource,
  canWriteSessionResource,
  minimalOwnerSessionSpace,
  ownerSessionSummary,
  ownerTaskListScope,
  ownerTaskListTaskType,
  type OwnerResourcePrincipal,
} from "./owner-resource-access.js";

const user = (uuid = "viewer-1"): OwnerResourcePrincipal => ({ type: "user", user: { uuid } });
const work = (uuid = "viewer-1", spaceId = "space-1", workId = "work-1"): OwnerResourcePrincipal => ({
  type: "work_session",
  workSession: { userUuid: uuid, spaceId, workId },
});
const preview = (uuid = "viewer-1", spaceId = "space-1"): OwnerResourcePrincipal => ({
  type: "preview_session",
  previewSession: { userUuid: uuid, spaceId },
});
const execution = (uuid = "viewer-1", spaceId = "space-1"): OwnerResourcePrincipal => ({
  type: "execution",
  execution: { actorUserId: uuid, spaceId },
});
const session = { id: "session-1", spaceId: "space-1", userUuid: "viewer-1" };

describe("owner-bound Work resource access", () => {
  it("lets a real account read its own session without upgrading scoped principals", async () => {
    assert.equal(await canReadSessionResource(user(), session, async () => false), true);
    assert.equal(await canReadSessionResource(preview(), session, async () => false), false);
    assert.equal(await canReadSessionResource(execution(), session, async () => false), false);
  });

  it("requires an active prompt grant and the exact Work space for owner session reads", async () => {
    const promptGranted = async (permission: string) => permission === "session.prompt.readonly";
    assert.equal(await canReadSessionResource(work(), session, promptGranted), true);
    assert.equal(await canReadSessionResource(work("viewer-1", "space-2"), session, promptGranted), false);
    assert.equal(await canReadSessionResource(work("viewer-2"), session, promptGranted), false);
    assert.equal(await canReadSessionResource(work(), session, async () => false), false);
  });

  it("preserves broad session.view access for explicitly scoped principals", async () => {
    assert.equal(await canReadSessionResource(
      preview(),
      session,
      async (permission) => permission === "session.view",
    ), true);
  });

  it("binds generation only to an account or Work owner in the same space", async () => {
    assert.equal(await canBindGenerationToSession(user(), session, async () => false), true);
    assert.equal(await canBindGenerationToSession(work(), session, async () => false), true);
    assert.equal(await canBindGenerationToSession(work("viewer-1", "space-2"), session, async () => false), false);
    assert.equal(await canBindGenerationToSession(preview(), session, async () => false), false);
    assert.equal(await canBindGenerationToSession(execution(), session, async () => false), false);
  });

  it("never upgrades read access into cross-owner Work writes", async () => {
    const promptOnly = async (permission: string) => permission === "session.prompt.fullaccess";
    const promptAndBroadRead = async (permission: string) => (
      permission === "session.prompt.fullaccess" || permission === "session.view"
    );
    assert.equal(await canWriteSessionResource(
      work(),
      session,
      "session.prompt.fullaccess",
      promptOnly,
    ), true);
    assert.equal(await canWriteSessionResource(
      work("viewer-2"),
      session,
      "session.prompt.fullaccess",
      promptOnly,
    ), false);
    assert.equal(await canWriteSessionResource(
      work("viewer-2"),
      session,
      "session.prompt.fullaccess",
      promptAndBroadRead,
    ), false);
  });

  it("reads owner generation tasks only with the active Work generation grant", async () => {
    const task = {
      taskType: "generation",
      spaceId: "space-1",
      sessionId: "session-1",
      userUuid: "viewer-1",
      payload: { data: { workId: "work-1" } },
    };
    assert.equal(await canReadTaskResource(user(), task, async () => false), true);
    assert.equal(await canReadTaskResource(
      work(),
      task,
      async (permission) => permission === "generation.create",
    ), true);
    assert.equal(await canReadTaskResource(work(), task, async () => false), false);
    assert.equal(await canReadTaskResource(
      work("viewer-1", "space-1", "work-2"),
      task,
      async (permission) => permission === "generation.create",
    ), false);
    assert.equal(await canReadTaskResource(
      work("viewer-1", "space-2"),
      task,
      async (permission) => permission === "generation.create",
    ), false);
    assert.equal(await canReadTaskResource(
      work(),
      { ...task, taskType: "run_command" },
      async (permission) => permission === "taskrun.view",
    ), false);
    assert.equal(await canReadTaskResource(
      work(),
      { ...task, userUuid: "viewer-2" },
      async (permission) => permission === "taskrun.view",
    ), false);
    assert.equal(await canReadTaskResource(preview(), task, async () => false), false);
    assert.equal(await canReadTaskResource(execution(), task, async () => false), false);
  });

  it("keeps taskrun.view as the explicit fallback for non-owner task reads", async () => {
    const task = { taskType: "generation", spaceId: "space-1", sessionId: "session-1", userUuid: "viewer-1" };
    assert.equal(await canReadTaskResource(
      preview("viewer-2"),
      task,
      async (permission) => permission === "taskrun.view",
    ), true);
  });

  it("limits owner task listing to accounts and the current Work space", () => {
    const accountScope = ownerTaskListScope(user());
    const workScope = ownerTaskListScope(work());
    assert.deepEqual(accountScope, {
      userUuid: "viewer-1",
      spaceId: null,
      workId: null,
      requiresGenerationGrant: false,
    });
    assert.deepEqual(workScope, {
      userUuid: "viewer-1",
      spaceId: "space-1",
      workId: "work-1",
      requiresGenerationGrant: true,
    });
    assert.ok(accountScope);
    assert.ok(workScope);
    assert.equal(ownerTaskListTaskType(accountScope, "run_command"), "run_command");
    assert.equal(ownerTaskListTaskType(workScope, undefined), "generation");
    assert.equal(ownerTaskListTaskType(workScope, "generation"), "generation");
    assert.equal(ownerTaskListTaskType(workScope, "run_command"), null);
    assert.equal(ownerTaskListScope(preview()), null);
    assert.equal(ownerTaskListScope(execution()), null);
  });

  it("returns no private Space fields without space.view", () => {
    assert.deepEqual(minimalOwnerSessionSpace({ id: "space-1", name: "Private", meta: { extraEnv: { SECRET: "value" } } }), {
      id: "space-1",
      name: "Private",
      accessLevel: "minimal",
    });
  });

  it("projects Work session lists without message or integration data", () => {
    const summary = ownerSessionSummary({
      id: "session-1",
      spaceId: "space-1",
      userUuid: "viewer-1",
      userProfile: { userUuid: "viewer-1", displayName: "Viewer" },
      title: "OpenTap",
      source: "opentap",
      status: "active",
      lastMessageAt: "2026-07-30T00:00:00.000Z",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      space: { id: "space-1", name: "Space" },
      latestMessageText: "private prompt",
      lastMessageId: "message-1",
      externalSessionId: "external-1",
      meta: { secret: "value" },
    });
    assert.equal("meta" in summary, false);
    assert.equal("externalSessionId" in summary, false);
    assert.equal("latestMessageText" in summary, false);
    assert.equal("lastMessageId" in summary, false);
    assert.deepEqual(summary.participantUserUuids, []);
    assert.deepEqual(summary.participantProfiles, []);
    assert.equal(JSON.stringify(summary).includes("private prompt"), false);
    assert.equal(JSON.stringify(summary).includes("external-1"), false);
    assert.equal(JSON.stringify(summary).includes("secret"), false);
  });
});
