import assert from "node:assert/strict";
import { test } from "node:test";
import {
  invitationLockKey,
  withInvitationLock,
} from "./invitation-lock.js";

test("accept and revoke derive the same opaque invitation lock key", () => {
  assert.equal(invitationLockKey("invite-token"), invitationLockKey("invite-token"));
  assert.notEqual(invitationLockKey("invite-token"), invitationLockKey("other-token"));
  assert.equal(invitationLockKey("invite-token").startsWith("invite:token-lock:"), true);
  assert.equal(invitationLockKey("invite-token").includes("invite-token"), false);
});

test("invitation lock releases after the guarded operation", async () => {
  const calls: string[] = [];
  const client = {
    async set(key: string, _value: string, _mode: "PX", _ttlMs: number, _condition: "NX") {
      calls.push(`set:${key}`);
      return "OK" as const;
    },
    async eval(_script: string, _numKeys: number, lockKey: string, _lockToken: string) {
      calls.push(`eval:${lockKey}`);
      return 1;
    },
  };
  const result = await withInvitationLock("invite-token", async () => "accepted", client);
  assert.equal(result, "accepted");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.startsWith("set:invite:token-lock:"), true);
  assert.equal(calls[1]?.startsWith("eval:"), true);
});

test("accept and revoke operations for one token cannot overlap", async () => {
  const locks = new Map<string, string>();
  const client = {
    async set(key: string, value: string, _mode: "PX", _ttlMs: number, _condition: "NX") {
      if (locks.has(key)) return null;
      locks.set(key, value);
      return "OK" as const;
    },
    async eval(script: string, _numKeys: number, lockKey: string, lockToken: string) {
      if (locks.get(lockKey) !== lockToken) return 0;
      if (script.includes("pexpire")) return 1;
      locks.delete(lockKey);
      return 1;
    },
  };
  const events: string[] = [];
  let finishAccept: (() => void) | undefined;
  const acceptFinished = new Promise<void>((resolve) => {
    finishAccept = resolve;
  });
  const accept = withInvitationLock("invite-token", async () => {
    events.push("accept:start");
    await acceptFinished;
    events.push("accept:end");
  }, client);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const revoke = withInvitationLock("invite-token", async () => {
    events.push("revoke");
  }, client);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["accept:start"]);

  finishAccept?.();
  await Promise.all([accept, revoke]);
  assert.deepEqual(events, ["accept:start", "accept:end", "revoke"]);
});

test("invitation lock renews while a guarded database write is running", async () => {
  const locks = new Map<string, string>();
  let refreshes = 0;
  const client = {
    async set(key: string, value: string, _mode: "PX", _ttlMs: number, _condition: "NX") {
      if (locks.has(key)) return null;
      locks.set(key, value);
      return "OK" as const;
    },
    async eval(script: string, _numKeys: number, lockKey: string, lockToken: string) {
      if (locks.get(lockKey) !== lockToken) return 0;
      if (script.includes("pexpire")) {
        refreshes += 1;
        return 1;
      }
      locks.delete(lockKey);
      return 1;
    },
  };

  await withInvitationLock(
    "slow-invite",
    () => new Promise<void>((resolve) => setTimeout(resolve, 35)),
    client,
    { ttlMs: 15 },
  );
  assert.equal(refreshes >= 2, true);
  assert.equal(locks.size, 0);
});
