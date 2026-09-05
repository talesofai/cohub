import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asAccountIdentity,
  canAccessUnscopedTaskRun,
  canViewOwnTaskRunsAccountWide,
  canViewTaskRunViaAccountScope,
  filterSpaceIdsByPermission,
  isTaskRunOwner,
  listAppSessionTaskRunSpaceIds,
} from "./permissions.js";

/**
 * Fakes the per-request memo that loads grant rows from the DB, so permission
 * logic can be exercised without a database.
 */
const resolvedGrants = (scopes: string[]) => [{ grantId: "grant-1", scopes }] as { grantId: string; scopes: string[] }[];

describe("asAccountIdentity", () => {
  it("recognizes a Task Run owner without requiring Space access", () => {
    assert.equal(isTaskRunOwner({ uuid: "user-1" }, { userUuid: "user-1" }), true);
    assert.equal(isTaskRunOwner({ uuid: "user-2" }, { userUuid: "user-1" }), false);
    assert.equal(isTaskRunOwner(null, { userUuid: "user-1" }), false);
  });

  it("keeps only the account uuid so app/preview scopes cannot leak into account lists", () => {
    const workish = {
      uuid: "user-1",
      appSession: {
        type: "app_session",
        spaceId: "home-space",
        appScopes: ["session.view"],
      },
    };
    assert.deepEqual(asAccountIdentity(workish), { uuid: "user-1" });
    assert.equal(
      Object.keys(asAccountIdentity(workish) as object).join(","),
      "uuid",
    );
  });

  it("scopes an app session's Task Run access to granted spaces only", async () => {
    // Not an app session: callers keep their own rules.
    assert.equal(await listAppSessionTaskRunSpaceIds({ uuid: "user-1" } as never), null);

    // App session without a taskrun.view viewer grant: no spaces at all —
    // publisher appScopes never open the account-level Task Run list.
    assert.deepEqual(
      await listAppSessionTaskRunSpaceIds({
        uuid: "user-1",
        appSession: {
          userUuid: "user-1",
          appScopes: ["taskrun.view"],
          viewerScopes: [],
          appViewerGrantId: null,
          activeAppState: Promise.resolve({ appScopes: ["taskrun.view"] }),
          anySpaceGrants: Promise.resolve([]),
        },
      } as never),
      [],
    );

    // App session whose only grants lack taskrun.view: still no spaces.
    assert.deepEqual(
      await listAppSessionTaskRunSpaceIds({
        uuid: "user-1",
        appSession: {
          userUuid: "user-1",
          appScopes: [],
          viewerScopes: [],
          activeAppState: Promise.resolve({ appScopes: [] }),
          anySpaceGrants: Promise.resolve(resolvedGrants(["file.view"])),
        },
      } as never),
      [],
    );
  });

  it("keeps unscoped Task Runs account-level: owners, or apps with user.taskrun.list", async () => {
    const appUser = {
      uuid: "user-1",
      appSession: {
        userUuid: "user-1",
        appScopes: ["taskrun.view"],
        viewerScopes: [],
        activeAppState: Promise.resolve({ appScopes: ["taskrun.view"] }),
        anySpaceGrants: Promise.resolve(resolvedGrants(["taskrun.view"])),
      },
    } as never;
    // A space-scoped taskrun.view grant does not open the account view.
    assert.equal(await canAccessUnscopedTaskRun(appUser, "user-1"), false);
    assert.equal(await canViewOwnTaskRunsAccountWide(appUser), false);
    assert.equal(await canAccessUnscopedTaskRun({ uuid: "user-1" } as never, "user-1"), true);
    assert.equal(await canAccessUnscopedTaskRun({ uuid: "user-2" } as never, "user-1"), false);

    // The account-level grant does.
    const accountAppUser = {
      uuid: "user-1",
      appSession: {
        userUuid: "user-1",
        appScopes: [],
        viewerScopes: ["user.taskrun.list"],
        activeAppState: Promise.resolve({ appScopes: [] }),
        anySpaceGrants: Promise.resolve(resolvedGrants(["user.taskrun.list"])),
      },
    };
    assert.equal(await canViewOwnTaskRunsAccountWide(accountAppUser as never), true);
    assert.equal(await canAccessUnscopedTaskRun(accountAppUser as never, "user-1"), true);
    assert.equal(await canAccessUnscopedTaskRun(accountAppUser as never, "user-2"), false);
    assert.equal(
      await canViewTaskRunViaAccountScope(accountAppUser as never, { userUuid: "user-1", spaceId: "lost-space" }),
      true,
    );
    assert.equal(
      await canViewTaskRunViaAccountScope(accountAppUser as never, { userUuid: "user-2", spaceId: "lost-space" }),
      false,
    );

    const disabledAppUser = {
      ...accountAppUser,
      appSession: {
        ...accountAppUser.appSession,
        activeAppState: Promise.resolve(null),
      },
    } as never;
    assert.equal(await canViewOwnTaskRunsAccountWide(disabledAppUser), false);
    assert.equal(await canAccessUnscopedTaskRun(disabledAppUser, "user-1"), false);

    // Real users always have their own account view.
    assert.equal(await canViewOwnTaskRunsAccountWide({ uuid: "user-1" } as never), true);
  });

  it("filters spaces for an app session without touching the store for the home space", async () => {
    // App-side grant covers the home space outright; no other space has a
    // viewer grant, so the batched path never reaches a membership query.
    const appSession = {
      type: "app_session",
      userUuid: "user-1",
      appId: "app-1",
      spaceId: "space-home",
      appScopes: ["space.view", "file.view"],
      viewerScopes: [],
      activeAppState: Promise.resolve({ appScopes: ["space.view", "file.view"] }),
      anySpaceGrants: Promise.resolve([]),
    };
    const filtered = await filterSpaceIdsByPermission(
      { uuid: "user-1", appSession } as never,
      "space.view",
      ["space-home", "space-other"],
    );
    assert.deepEqual(filtered, ["space-home"]);
  });

  it("uses live publisher scopes instead of stale token scopes", async () => {
    const appSession = {
      type: "app_session",
      userUuid: "user-1",
      appId: "app-1",
      spaceId: "space-home",
      appScopes: ["file.edit"],
      viewerScopes: [],
      activeAppState: Promise.resolve({ appScopes: [] }),
      anySpaceGrants: Promise.resolve([]),
    };
    const filtered = await filterSpaceIdsByPermission(
      { uuid: "user-1", appSession } as never,
      "file.edit",
      ["space-home"],
    );
    assert.deepEqual(filtered, []);
  });

  it("returns null without a usable uuid", () => {
    assert.equal(asAccountIdentity(null), null);
    assert.equal(asAccountIdentity(undefined), null);
    assert.equal(asAccountIdentity({}), null);
    assert.equal(asAccountIdentity({ uuid: "   " }), null);
  });
});
