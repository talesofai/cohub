import assert from "node:assert/strict";
import test from "node:test";
import {
  SPACE_HOOKS_CACHE_TTL_SEC,
  SPACE_HOOKS_EMPTY_CACHE_TTL_SEC,
} from "@cohub/protocol";
import {
  buildHookRunCommand,
  buildSpaceHookDefinitionFingerprint,
  buildSpaceHookEnv,
  buildSpaceHookPromptText,
  mergeSpaceHookExecutionEnv,
  parseSpaceHookDefinition,
  partitionSpaceHooksForEvent,
  resolveSpaceHooksCacheTtlSec,
  spaceHookMatchesEvent,
} from "./index.js";

test("parseSpaceHookDefinition accepts inline run hooks", () => {
  const hook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: space.fs.changed
  paths:
    - src/**
run: |
  npm test
`,
    ".cohub/hooks/on-fs-changed.yml",
  );
  assert.equal(hook.event, "space.fs.changed");
  assert.deepEqual(hook.paths, ["src/**"]);
  assert.equal(hook.action, "run");
  assert.equal(hook.run?.includes("npm test"), true);
});

test("parseSpaceHookDefinition accepts prompt hooks", () => {
  const hook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: checkpoint.created
prompt:
  text: summarize the new checkpoint
  intent: followup
`,
    ".cohub/hooks/on-checkpoint.yml",
  );
  assert.equal(hook.action, "prompt");
  assert.equal(hook.prompt?.text, "summarize the new checkpoint");
  assert.equal(hook.prompt?.intent, "followup");
});

test("parseSpaceHookDefinition accepts published Work version hooks", () => {
  const hook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: work.version.published
run: echo "$COHUB_HOOK_WORK_VERSION"
`,
    ".cohub/hooks/on-work-published.yml",
  );
  assert.equal(hook.event, "work.version.published");
  assert.equal(hook.action, "run");
});

test("parseSpaceHookDefinition accepts top-level env for run and prompt", () => {
  const runHook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: space.fs.changed
env:
  REVIEW_SCOPE: public
  ENABLE_FAST: "1"
run: |
  echo "$REVIEW_SCOPE"
`,
    ".cohub/hooks/run-env.yml",
  );
  assert.equal(runHook.action, "run");
  assert.deepEqual(runHook.env, {
    REVIEW_SCOPE: "public",
    ENABLE_FAST: "1",
  });

  const promptHook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: checkpoint.created
env:
  REVIEW_SCOPE: public
prompt:
  text: review checkpoint
`,
    ".cohub/hooks/prompt-env.yml",
  );
  assert.equal(promptHook.action, "prompt");
  assert.deepEqual(promptHook.env, { REVIEW_SCOPE: "public" });
});

test("parseSpaceHookDefinition keeps legacy prompt.env as fallback", () => {
  const hook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: checkpoint.created
prompt:
  text: review checkpoint
  env:
    LEGACY: "1"
`,
    ".cohub/hooks/legacy-prompt-env.yml",
  );
  assert.deepEqual(hook.env, { LEGACY: "1" });
});

test("parseSpaceHookDefinition rejects reserved system env keys", () => {
  assert.throws(
    () => parseSpaceHookDefinition(
      `
schema: cohub.space-hook.v1
on:
  event: space.fs.changed
env:
  COHUB_HOOK_PATH: hacked
run: echo hi
`,
      ".cohub/hooks/bad-env.yml",
    ),
    /reserved by the system/,
  );
});

test("mergeSpaceHookExecutionEnv lets system hook keys win", () => {
  const merged = mergeSpaceHookExecutionEnv({
    userEnv: {
      REVIEW_SCOPE: "public",
      COHUB_HOOK_PATH: "hacked",
    },
    hookEnv: {
      COHUB_HOOK_PATH: ".cohub/hooks/real.yml",
      COHUB_HOOK_EVENT_TYPE: "space.fs.changed",
    },
  });
  assert.deepEqual(merged, {
    REVIEW_SCOPE: "public",
    COHUB_HOOK_PATH: ".cohub/hooks/real.yml",
    COHUB_HOOK_EVENT_TYPE: "space.fs.changed",
  });
});

test("parseSpaceHookDefinition rejects run and prompt together", () => {
  assert.throws(() => parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: space.fs.changed
run: echo hi
prompt: hello
`,
    ".cohub/hooks/bad.yml",
  ));
});

test("spaceHookMatchesEvent filters fs paths", () => {
  const hook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: space.fs.changed
  paths:
    - src/**
  ignore:
    - src/generated/**
run: echo ok
`,
    ".cohub/hooks/check.yml",
  );

  assert.equal(
    spaceHookMatchesEvent(hook, {
      id: "1",
      type: "space.fs.changed",
      timestamp: Date.now(),
      spaceId: "space",
      payload: {
        changes: [{ path: "src/index.ts", kind: "modify" }],
      },
    }).matched,
    true,
  );

  assert.equal(
    spaceHookMatchesEvent(hook, {
      id: "2",
      type: "space.fs.changed",
      timestamp: Date.now(),
      spaceId: "space",
      payload: {
        changes: [{ path: "src/generated/a.ts", kind: "modify" }],
      },
    }).matched,
    false,
  );
});

test("parseSpaceHookDefinition accepts session turn filters", () => {
  const hook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: session.turn.finalized
  sessionIds:
    - session-a
    - session-b
  ignoreSessionIds:
    - session-skip
  sources:
    - web_app
    - cli
run: echo ok
`,
    ".cohub/hooks/on-turn.yml",
  );
  assert.equal(hook.event, "session.turn.finalized");
  assert.deepEqual(hook.sessionIds, ["session-a", "session-b"]);
  assert.deepEqual(hook.ignoreSessionIds, ["session-skip"]);
  assert.deepEqual(hook.sources, ["web_app", "cli"]);
});

test("spaceHookMatchesEvent filters session turn finalized events", () => {
  const hook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: session.turn.finalized
  sessionIds:
    - session-a
    - session-b
  ignoreSessionIds:
    - session-b
  sources:
    - web_app
    - cli
run: echo ok
`,
    ".cohub/hooks/on-turn.yml",
  );

  const base = {
    id: "evt-1",
    type: "session.turn.finalized" as const,
    timestamp: Date.now(),
    spaceId: "space-1",
  };

  assert.deepEqual(
    spaceHookMatchesEvent(hook, {
      ...base,
      sessionId: "session-a",
      payload: { turn: { id: "turn-1", meta: { source: "web_app" } } },
    }),
    { matched: true },
  );

  assert.deepEqual(
    spaceHookMatchesEvent(hook, {
      ...base,
      sessionId: "session-c",
      payload: { turn: { id: "turn-1", meta: { source: "web_app" } } },
    }),
    { matched: false, reason: "session_filter" },
  );

  assert.deepEqual(
    spaceHookMatchesEvent(hook, {
      ...base,
      sessionId: "session-b",
      payload: { turn: { id: "turn-1", meta: { source: "web_app" } } },
    }),
    { matched: false, reason: "session_ignored" },
  );

  assert.deepEqual(
    spaceHookMatchesEvent(hook, {
      ...base,
      sessionId: "session-a",
      payload: { turn: { id: "turn-1", meta: { source: "space_hook" } } },
    }),
    { matched: false, reason: "source_filter" },
  );

  assert.deepEqual(
    spaceHookMatchesEvent(hook, {
      ...base,
      sessionId: "session-a",
      payload: { turn: { id: "turn-1" } },
    }),
    { matched: false, reason: "source_filter" },
  );

  assert.deepEqual(
    spaceHookMatchesEvent(hook, {
      ...base,
      payload: { turn: { id: "turn-1", meta: { source: "web_app" } } },
    }),
    { matched: false, reason: "no_session" },
  );

  const openHook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: session.turn.finalized
run: echo ok
`,
    ".cohub/hooks/on-turn-open.yml",
  );
  assert.equal(
    spaceHookMatchesEvent(openHook, {
      ...base,
      sessionId: "any-session",
      payload: { turn: { id: "turn-2", meta: { source: "anything" } } },
    }).matched,
    true,
  );
});

test("spaceHookMatchesEvent matches task.updated events", () => {
  const hook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: task.updated
run: echo ok
`,
    ".cohub/hooks/on-task.yml",
  );

  const base = {
    id: "evt-1",
    type: "task.updated" as const,
    timestamp: Date.now(),
    spaceId: "space-1",
  };

  // Any task.updated payload matches (status filtering is the script's job,
  // event payload carries COHUB_HOOK_TASK_STATUS).
  assert.deepEqual(
    spaceHookMatchesEvent(hook, {
      ...base,
      sessionId: "session-1",
      payload: {
        task: { id: "task-1", type: "generation", status: "failed", jobId: "job-1" },
        changed: ["status"],
      },
    }),
    { matched: true },
  );

  assert.deepEqual(
    spaceHookMatchesEvent(hook, {
      ...base,
      sessionId: "session-1",
      payload: { task: { id: "task-2", type: "run_command", status: "completed", jobId: "job-2" } },
    }),
    { matched: true },
  );

  assert.deepEqual(
    spaceHookMatchesEvent(hook, {
      ...base,
      sessionId: "session-1",
      payload: { task: { id: "task-3", type: "generation", status: "running", jobId: "job-3" } },
    }),
    { matched: true },
  );

  assert.deepEqual(
    spaceHookMatchesEvent(hook, {
      ...base,
      type: "checkpoint.created" as const,
      payload: { checkpointId: "cp-1" },
    }),
    { matched: false, reason: "event_mismatch" },
  );
});

test("space hook fingerprints change with executable content", () => {
  const first = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: checkpoint.created
run: echo first
`,
    ".cohub/hooks/checkpoint.yml",
  );
  const second = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: checkpoint.created
run: echo second
`,
    ".cohub/hooks/checkpoint.yml",
  );
  assert.match(buildSpaceHookDefinitionFingerprint(first), /^[0-9a-f]{64}$/);
  assert.notEqual(
    buildSpaceHookDefinitionFingerprint(first),
    buildSpaceHookDefinitionFingerprint(second),
  );
});

test("partitionSpaceHooksForEvent splits matched and skipped", () => {
  const fsHook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: space.fs.changed
  paths:
    - src/**
run: echo fs
`,
    ".cohub/hooks/fs.yml",
  );
  const checkpointHook = parseSpaceHookDefinition(
    `
schema: cohub.space-hook.v1
on:
  event: checkpoint.created
run: echo cp
`,
    ".cohub/hooks/cp.yml",
  );
  const { matched, skipped } = partitionSpaceHooksForEvent(
    [fsHook, checkpointHook],
    {
      id: "evt-1",
      type: "checkpoint.created",
      timestamp: Date.now(),
      spaceId: "space-1",
      payload: {},
    },
  );
  assert.deepEqual(matched.map((item) => item.path), [".cohub/hooks/cp.yml"]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.path, ".cohub/hooks/fs.yml");
  assert.equal(skipped[0]?.reason, "event_mismatch");
});

test("buildHookRunCommand only wraps the user script", () => {
  assert.equal(buildHookRunCommand("npm test"), "set -euo pipefail\nnpm test");
  assert.equal(buildHookRunCommand("npm test").includes("COHUB_HOOK_EVENT_FILE"), false);
});

test("buildSpaceHookEnv always exports optional ids as empty strings when absent", () => {
  const turnEnv = buildSpaceHookEnv({
    event: {
      id: "evt-turn",
      type: "session.turn.finalized",
      timestamp: Date.parse("2026-07-20T00:00:00.000Z"),
      spaceId: "space-1",
      sessionId: "session-1",
      payload: { turn: { id: "turn-1", status: "completed" } },
    },
    hookPath: ".cohub/hooks/on-turn.yml",
    taskRunId: "task-run-1",
    eventActorUserId: "actor-1",
    executionUserId: "owner-1",
  });
  assert.deepEqual(turnEnv, {
    COHUB_HOOK_PATH: ".cohub/hooks/on-turn.yml",
    COHUB_HOOK_TASK_RUN_ID: "task-run-1",
    COHUB_HOOK_EVENT_ID: "evt-turn",
    COHUB_HOOK_EVENT_TYPE: "session.turn.finalized",
    COHUB_HOOK_SPACE_ID: "space-1",
    COHUB_HOOK_OCCURRED_AT: "2026-07-20T00:00:00.000Z",
    COHUB_HOOK_EXECUTION_USER_ID: "owner-1",
    COHUB_HOOK_ACTOR_USER_ID: "actor-1",
    COHUB_HOOK_SESSION_ID: "session-1",
    COHUB_HOOK_TURN_ID: "turn-1",
    COHUB_HOOK_CHECKPOINT_ID: "",
    COHUB_HOOK_WORK_ID: "",
    COHUB_HOOK_WORK_VERSION_ID: "",
    COHUB_HOOK_WORK_VERSION: "",
  });
  assert.equal("COHUB_HOOK_TURN_STATUS" in turnEnv, false);

  const checkpointEnv = buildSpaceHookEnv({
    event: {
      id: "evt-cp",
      type: "checkpoint.created",
      timestamp: Date.parse("2026-07-20T00:00:00.000Z"),
      spaceId: "space-1",
      payload: { checkpointId: "cp-1", commitHash: "abc123" },
    },
    hookPath: ".cohub/hooks/on-checkpoint.yml",
    taskRunId: "task-run-2",
    executionUserId: "owner-1",
  });
  assert.equal(checkpointEnv.COHUB_HOOK_CHECKPOINT_ID, "cp-1");
  assert.equal(checkpointEnv.COHUB_HOOK_ACTOR_USER_ID, "");
  assert.equal(checkpointEnv.COHUB_HOOK_SESSION_ID, "");
  assert.equal(checkpointEnv.COHUB_HOOK_TURN_ID, "");
  assert.equal("COHUB_HOOK_COMMIT_HASH" in checkpointEnv, false);

  const readyEnv = buildSpaceHookEnv({
    event: {
      id: "evt-ready",
      type: "space.workspace.ready",
      timestamp: Date.parse("2026-07-20T00:00:00.000Z"),
      spaceId: "space-1",
      payload: { stage: "finalize" },
    },
    hookPath: ".cohub/hooks/on-ready.yml",
    taskRunId: "task-run-3",
    executionUserId: "owner-1",
  });
  assert.equal("COHUB_HOOK_WORKSPACE_STAGE" in readyEnv, false);
  assert.equal(readyEnv.COHUB_HOOK_EVENT_TYPE, "space.workspace.ready");
  assert.equal(readyEnv.COHUB_HOOK_ACTOR_USER_ID, "");
  assert.equal(readyEnv.COHUB_HOOK_SESSION_ID, "");
  assert.equal(readyEnv.COHUB_HOOK_TURN_ID, "");
  assert.equal(readyEnv.COHUB_HOOK_CHECKPOINT_ID, "");
});

test("buildSpaceHookEnv exposes published work version ids", () => {
  const env = buildSpaceHookEnv({
    event: {
      id: "evt-work",
      type: "work.version.published",
      timestamp: Date.parse("2026-07-20T00:00:00.000Z"),
      spaceId: "space-1",
      payload: {
        work: { id: "work-1" },
        version: { id: "version-3", version: 3 },
      },
    },
    hookPath: ".cohub/hooks/on-work.yml",
    taskRunId: "task-run-work",
    executionUserId: "owner-1",
  });
  assert.equal(env.COHUB_HOOK_WORK_ID, "work-1");
  assert.equal(env.COHUB_HOOK_WORK_VERSION_ID, "version-3");
  assert.equal(env.COHUB_HOOK_WORK_VERSION, "3");
});

test("buildSpaceHookEnv summarizes fs changes without resync/truncated flags", () => {
  const env = buildSpaceHookEnv({
    event: {
      id: "evt-fs",
      type: "space.fs.changed",
      timestamp: Date.parse("2026-07-20T00:00:00.000Z"),
      spaceId: "space-1",
      payload: {
        resync: true,
        changes: [
          { path: "src/a.ts", kind: "modify" },
          { path: "src/b.ts", kind: "create" },
          { path: "src/a.ts", kind: "modify" },
        ],
      },
    },
    hookPath: ".cohub/hooks/on-fs.yml",
    taskRunId: "task-run-fs",
    executionUserId: "owner-1",
  });
  assert.equal(env.COHUB_HOOK_FS_CHANGE_COUNT, "2");
  assert.equal(env.COHUB_HOOK_FS_PATHS, "src/a.ts\nsrc/b.ts");
  assert.equal(env.COHUB_HOOK_FS_KINDS, "modify,create");
  assert.equal(env.COHUB_HOOK_ACTOR_USER_ID, "");
  assert.equal(env.COHUB_HOOK_SESSION_ID, "");
  assert.equal(env.COHUB_HOOK_TURN_ID, "");
  assert.equal(env.COHUB_HOOK_CHECKPOINT_ID, "");
  assert.equal("COHUB_HOOK_FS_RESYNC" in env, false);
  assert.equal("COHUB_HOOK_FS_TRUNCATED" in env, false);

  const emptyFsEnv = buildSpaceHookEnv({
    event: {
      id: "evt-fs-empty",
      type: "space.fs.changed",
      timestamp: Date.parse("2026-07-20T00:00:00.000Z"),
      spaceId: "space-1",
      payload: { changes: [] },
    },
    hookPath: ".cohub/hooks/on-fs.yml",
    taskRunId: "task-run-fs-empty",
    executionUserId: "owner-1",
  });
  assert.equal(emptyFsEnv.COHUB_HOOK_FS_CHANGE_COUNT, "0");
  assert.equal(emptyFsEnv.COHUB_HOOK_FS_PATHS, "");
  assert.equal(emptyFsEnv.COHUB_HOOK_FS_KINDS, "");
});

test("resolveSpaceHooksCacheTtlSec uses the same TTL for positive and empty caches", () => {
  assert.equal(resolveSpaceHooksCacheTtlSec(3), SPACE_HOOKS_CACHE_TTL_SEC);
  assert.equal(resolveSpaceHooksCacheTtlSec(0), SPACE_HOOKS_EMPTY_CACHE_TTL_SEC);
  assert.equal(SPACE_HOOKS_EMPTY_CACHE_TTL_SEC, SPACE_HOOKS_CACHE_TTL_SEC);
});

test("buildSpaceHookPromptText only mirrors present context fields", () => {
  const text = buildSpaceHookPromptText({
    promptText: "Review the turn",
    env: {
      COHUB_HOOK_EVENT_TYPE: "session.turn.finalized",
      COHUB_HOOK_EVENT_ID: "evt-1",
      COHUB_HOOK_TASK_RUN_ID: "task-1",
      COHUB_HOOK_PATH: ".cohub/hooks/on-turn.yml",
      COHUB_HOOK_SESSION_ID: "session-1",
      COHUB_HOOK_TURN_ID: "turn-1",
    },
  });
  assert.match(text, /^Review the turn\n\n---\nHook context/);
  assert.match(text, /- turnId: turn-1/);
  assert.equal(text.includes("payload"), false);
  assert.equal(text.includes("tasks.get"), false);
});
